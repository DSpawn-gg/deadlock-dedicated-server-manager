// Windows backend for the DDSM web dashboard.
//
// Replaces the Linux dockerode implementation. The dashboard's API surface
// is preserved exactly (function names + shapes) so route handlers and
// servers.ts compile unchanged.
//
// On Windows, a "container" is just a deadworks.exe process spawned from
// the slot's generated start.ps1. The mapping is:
//
//   container_id (servers.container_id column)  =  slot UUID (= server.id)
//   PID is tracked in <SERVERS_DIR>/<id>/.ddsm-process.json
//
// This matches the Go CLI's choice in cli/internal/ddsm/server_windows.go
// EXCEPT that the CLI overloads container_id with the PID after start.
// Storing the slot UUID instead is stable across restarts, survives
// dashboard reboots, and lets us reattach to a running process.
//
// All work funnels through small PowerShell snippets to avoid pulling in
// native node-windows-process dependencies. The two cold paths are
// taskkill.exe and powershell.exe; both ship with Windows.

import { spawn, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { SERVERS_DIR } from "./config";
import { getDb } from "./db";

const execFileAsync = promisify(execFile);

const PROC_RECORD_FILENAME = ".ddsm-process.json";
const STDOUT_FRAME = 1;

interface ProcRecord {
  pid: number;
  startedAt: string; // ISO8601
  port: number;
}

export interface ContainerInfo {
  id: string;
  status: string;
  state: string; // "running" | "exited"
  startedAt: string;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
}

// --- slot path helpers ----------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Translate any `container_id` we might see into a slot UUID.
 *
 * Slots created by THIS dashboard store the slot UUID directly. But slots
 * created by the Go CLI store either the placeholder name (`deadlock-<id[:8]>`)
 * or, after first start, the PID-as-string. Translate those by reverse-
 * looking-up in the servers table so the dashboard can manage CLI slots
 * without manual DB rewrites.
 */
function resolveSlotId(containerId: string): string {
  // Fast path: full UUID — assume it IS the slot id.
  if (UUID_RE.test(containerId)) return containerId;

  // Look up the row whose container_id matches what we were handed.
  const row = getDb().prepare("SELECT id FROM servers WHERE container_id = ?")
                    .get(containerId) as { id: string } | undefined;
  if (row?.id) return row.id;

  // Fall back: `deadlock-<short>` placeholder used by the CLI before first
  // start. Match by id prefix.
  const m = /^deadlock-([0-9a-f]{8})$/i.exec(containerId);
  if (m) {
    const prefRow = getDb().prepare("SELECT id FROM servers WHERE id LIKE ?")
                          .get(`${m[1]}%`) as { id: string } | undefined;
    if (prefRow?.id) return prefRow.id;
  }

  throw new Error(`cannot resolve slot for container_id=${containerId}`);
}

function slotDir(slotId: string): string {
  return path.join(SERVERS_DIR, slotId);
}

function procRecordPath(slotId: string): string {
  return path.join(slotDir(slotId), PROC_RECORD_FILENAME);
}

function readProcRecord(slotId: string): ProcRecord | null {
  try {
    const buf = fs.readFileSync(procRecordPath(slotId), "utf8");
    return JSON.parse(buf) as ProcRecord;
  } catch {
    return null;
  }
}

function writeProcRecord(slotId: string, rec: ProcRecord): void {
  fs.writeFileSync(procRecordPath(slotId), JSON.stringify(rec, null, 2));
}

function deleteProcRecord(slotId: string): void {
  try { fs.unlinkSync(procRecordPath(slotId)); } catch { /* ok */ }
}

// Native Node liveness check. process.kill(pid, 0) doesn't actually send
// a signal — it just probes whether the kernel has a record of that pid.
// Throws ESRCH (no such process) or EPERM (exists but inaccessible).
// Microseconds, no powershell spawn — critical because GET /api/servers
// and the autosleep poller both call this every few seconds.
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

// --- start.ps1 generation -------------------------------------------------
//
// Mirrors cli/internal/ddsm/server_windows_script.go::renderWindowsStartScript
// so a slot started by `ddsm.exe start` and a slot started by the dashboard
// produce identical processes.

function renderStartScript(volumePath: string, port: number, env: Record<string, string>): string {
  const mapName = env.MAP || "dl_streets";
  const password = env.SERVER_PASSWORD || "";

  // PowerShell treats backslash literally in double-quoted strings, so single
  // backslashes in volumePath are fine. Only escape embedded double-quotes.
  const psVolume = volumePath.replace(/"/g, '`"');

  const extraEnv = Object.keys(env)
    .filter(k => k !== "MAP" && k !== "PORT" && k !== "SERVER_PASSWORD")
    .sort()
    .map(k => '$env:' + k + ' = "' + (env[k] ?? "").replace(/"/g, '\\"') + '"')
    .join("\n");

  const pwLine = password
    ? '$EngineArgs += "+sv_password", "' + password.replace(/"/g, '\\"') + '"'
    : "";

  // Built via concatenation instead of one giant template literal — keeps
  // Turbopack's TS parser from getting confused by PowerShell's `$(...)`
  // subexpressions colliding with TS's `${...}` interpolations.
  const lines = [
    '# Generated by DDSM Windows dashboard - do not edit',
    '# ErrorActionPreference=Continue so harmless stderr lines from deadworks',
    '# (e.g. "Using breakpad crash handler") do not trip Stop-mode and abort.',
    '$ErrorActionPreference = "Continue"',
    '$VOLUME = "' + psVolume + '"',
    '$DEADLOCK_DIR = Join-Path $VOLUME "Deadlock"',
    '$DEADWORKS_EXE = Join-Path $DEADLOCK_DIR "game\\bin\\win64\\deadworks.exe"',
    '$DEADLOCK_EXE  = Join-Path $DEADLOCK_DIR "game\\bin\\win64\\deadlock.exe"',
    '$ProcRecord = Join-Path $VOLUME ".ddsm-process.json"',
    '',
    extraEnv,
    '$EXE = if (Test-Path $DEADWORKS_EXE) { $DEADWORKS_EXE } else { $DEADLOCK_EXE }',
    'if (-not (Test-Path $EXE)) {',
    '    "Server binary not found at $EXE" | Out-File -Append -FilePath (Join-Path $DEADLOCK_DIR "dspawn.log") -Encoding utf8',
    '    exit 1',
    '}',
    '',
    '$EngineArgs = @(',
    '    "-dedicated", "-usercon", "-insecure", "-ip", "0.0.0.0",',
    '    "-convars_visible_by_default", "-allow_no_lobby_connect", "-novid",',
    '    "-port", "' + port + '", "+map", "' + mapName + '",',
    '    "+rcon_password", "ddsm_rcon_secret", "+sv_cheats", "0",',
    '    "+tv_enable", "0", "+citadel_upload_replay_enabled", "0",',
    '    "+tv_citadel_auto_record", "0", "+spec_replay_enable", "0",',
    '    "+fps_max", "30", "-width", "640", "-height", "480", "-nojoy"',
    ')',
    pwLine,
    '$LogPath = Join-Path $DEADLOCK_DIR "dspawn.log"',
    'Set-Location (Split-Path $EXE -Parent)',
    '"=== ddsm-web start $(Get-Date -Format o) port=' + port + ' map=' + mapName + ' exe=$EXE ===" |',
    '    Out-File -Append -FilePath $LogPath -Encoding utf8',
    '',
    '# Launch via Start-Process -PassThru so we capture the engine PID directly',
    '# (no descendant-walking, no wmic parsing). Persist PID + startedAt + port',
    '# into .ddsm-process.json so the dashboard getContainerInfo reads it.',
    '$Game = Start-Process -FilePath $EXE -ArgumentList $EngineArgs `',
    '    -RedirectStandardOutput $LogPath -RedirectStandardError "$LogPath.err" `',
    '    -NoNewWindow -PassThru',
    '',
    '$rec = @{',
    '    pid = $Game.Id',
    '    startedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '    port = ' + port,
    '} | ConvertTo-Json -Compress',
    '[IO.File]::WriteAllText($ProcRecord, $rec, [System.Text.UTF8Encoding]::new($false))',
    '"recorded deadworks PID $($Game.Id) to $ProcRecord" |',
    '    Out-File -Append -FilePath $LogPath -Encoding utf8',
    '',
    '# Block on the engine until it exits, then clear the proc record so the',
    '# dashboard reports "exited" promptly instead of relying on isPidAlive.',
    '$Game.WaitForExit()',
    '$exitCode = $Game.ExitCode',
    '"=== ddsm-web exit $(Get-Date -Format o) code=$exitCode ===" |',
    '    Out-File -Append -FilePath $LogPath -Encoding utf8',
    'Remove-Item $ProcRecord -Force -ErrorAction SilentlyContinue',
  ];

  return lines.join("\n");
}

// --- Public API: lifecycle ------------------------------------------------

export async function createContainer(opts: {
  name: string;
  port: number;
  env: Record<string, string>;
  volumePath: string;
}): Promise<string> {
  fs.mkdirSync(opts.volumePath, { recursive: true });
  const scriptPath = path.join(opts.volumePath, "start.ps1");
  fs.writeFileSync(scriptPath, renderStartScript(opts.volumePath, opts.port, opts.env));
  // container_id == slot UUID == directory basename. Stable across runs.
  return path.basename(opts.volumePath);
}

export async function startContainer(containerId: string): Promise<void> {
  const slotId = resolveSlotId(containerId);
  const scriptPath = path.join(slotDir(slotId), "start.ps1");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`start.ps1 missing for slot ${slotId} at ${scriptPath}`);
  }
  // If a process is already recorded as alive, no-op (idempotent).
  const existing = readProcRecord(slotId);
  if (existing && isPidAlive(existing.pid)) return;

  // start.ps1 writes deadworks.exe's real PID directly to .ddsm-process.json
  // via Start-Process -PassThru, so no descendant-walking or wmic parsing is
  // needed here. PowerShell single-quoted strings do NOT escape backslashes —
  // pass slot path with single backslashes for use later in the script.
  const slotPathLiteral = slotDir(slotId);

  // We CANNOT use child_process.spawn here. When the dashboard runs from
  // Session 0 (Scheduled Task with stored password), Node's spawn of
  // powershell.exe returns a PID but Windows terminates the spawned process
  // before script execution begins. The reproducible workaround is to
  // launch start.ps1 through the Task Scheduler — tasks are decoupled from
  // the launcher's process group and survive cleanly.
  //
  // We register a per-slot task `dspawn-game-<slot>` (idempotent) and
  // trigger it via Start-ScheduledTask. The actual PID of the powershell
  // host running start.ps1 is discovered after launch by command-line
  // match so stopContainer can taskkill the tree.

  const taskName = `dspawn-game-${slotId}`;
  const adminPass = process.env.DDSM_ADMIN_PASS;
  if (!adminPass) {
    throw new Error(
      "DDSM_ADMIN_PASS env var is not set on the dashboard. Set it to the Administrator password so the dashboard can register/trigger per-slot scheduled tasks for game server launches.",
    );
  }

  // (Unused after the .Contains() switch; the polling loop now uses
  // $slotPath via single-quoted literal, no escape doubling needed.)

  // After triggering the task, we wait until a powershell.exe appears that
  // has deadworks.exe or deadlock.exe as a CHILD process. That's the real
  // start.ps1 host — recording its PID means stopContainer's
  // `taskkill /T /PID <pid>` kills the entire tree (pwsh + game). If we
  // recorded an earlier task-wrapper pwsh's PID, isPidAlive would return
  // false after the wrapper exits, and the dashboard would falsely report
  // "exited" while the game keeps running.
  // Use the same single-quoted $slotPath as discovery — single backslashes.
  const psCmd =
    `$ErrorActionPreference = 'Continue'\n` + // changed from Stop: we want polling to complete instead of aborting on transient WMI errors
    `try {\n` +
    `  Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null\n` +
    `  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"' -WorkingDirectory '${slotPathLiteral}'\n` +
    `  $trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddYears(10))\n` +
    `  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)\n` +
    `  Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -User 'Administrator' -Password '${adminPass}' -RunLevel Highest -Force -ErrorAction Stop | Out-Null\n` +
    `  Start-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop\n` +
    `} catch {\n` +
    `  Write-Error "TASK_REGISTER_FAILED: $($_.Exception.Message)"\n` +
    `  exit 2\n` +
    `}\n` +
    `# Wait up to 30s for deadworks.exe (whose ancestor pwsh has our slot path) to appear.\n` +
    `$slotPath = '${slotPathLiteral}'\n` +
    `$deadline = (Get-Date).AddSeconds(30)\n` +
    `$gamePid = 0\n` +
    `while ((Get-Date) -lt $deadline -and $gamePid -eq 0) {\n` +
    `  $games = Get-CimInstance Win32_Process -Filter "Name='deadworks.exe' OR Name='deadlock.exe'" -ErrorAction SilentlyContinue\n` +
    `  foreach ($g in $games) {\n` +
    `    $cur = $g; $hops = 0\n` +
    `    while ($cur -and $hops -lt 6) {\n` +
    `      if ($cur.CommandLine -and $cur.CommandLine.Contains($slotPath)) { $gamePid = $g.ProcessId; break }\n` +
    `      $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue\n` +
    `      $hops++\n` +
    `    }\n` +
    `    if ($gamePid) { break }\n` +
    `  }\n` +
    `  if ($gamePid -eq 0) { Start-Sleep -Milliseconds 750 }\n` +
    `}\n` +
    `$gamePid\n`;

  // Fire-and-return: registering and triggering the task takes <2 seconds,
  // but waiting for deadworks.exe to appear can take 25+ seconds. The
  // dashboard polls status every ~15s — there's no value in blocking the
  // POST response on that. We just fire the task and let the next
  // getContainerInfo discover the new deadworks PID.
  const fireCmd =
    `$ErrorActionPreference = 'Continue'\n` +
    `try {\n` +
    `  Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null\n` +
    `  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"' -WorkingDirectory '${slotPathLiteral}'\n` +
    `  $trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddYears(10))\n` +
    `  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)\n` +
    `  Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -User 'Administrator' -Password '${adminPass}' -RunLevel Highest -Force -ErrorAction Stop | Out-Null\n` +
    `  Start-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop\n` +
    `  'OK'\n` +
    `} catch {\n` +
    `  Write-Error "TASK_FIRE_FAILED: $($_.Exception.Message)"\n` +
    `  exit 2\n` +
    `}\n`;

  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", fireCmd], {
      timeout: 10000,
    });
  } catch (err: any) {
    const stderr = String(err?.stderr ?? "").trim();
    const stdoutPartial = String(err?.stdout ?? "").trim();
    throw new Error(
      `startContainer task-fire failed (exit ${err?.code ?? "?"}): ${stderr || stdoutPartial || err?.message}`,
    );
  }
  // Write a "starting" marker so getContainerInfo distinguishes a freshly
  // fired task from a never-started slot. Real PID gets backfilled by
  // discovery on the next status poll once deadworks.exe appears.
  writeProcRecord(slotId, {
    pid: -1,
    startedAt: new Date().toISOString(),
    port: 0,
  });
  bustCaches(slotId);
}

function bustCaches(slotId: string) {
  infoCache.delete(slotId);
  statsCache.delete(slotId);
}

export async function stopContainer(containerId: string): Promise<void> {
  let slotId: string;
  try { slotId = resolveSlotId(containerId); } catch { return; }
  bustCaches(slotId);
  const rec = readProcRecord(slotId);
  if (!rec || !rec.pid) return;
  try {
    await execFileAsync(
      "taskkill.exe",
      ["/F", "/T", "/PID", String(rec.pid)],
      { timeout: 10000 }
    );
  } catch (err: any) {
    // Tolerate "not found" / "not running" — happens when the host already exited.
    const msg = String(err?.stdout ?? "") + String(err?.stderr ?? "");
    if (!/not found|not running/i.test(msg)) {
      throw new Error(`taskkill failed: ${msg || err.message}`);
    }
  }
  deleteProcRecord(slotId);
}

export async function restartContainer(containerId: string): Promise<void> {
  await stopContainer(containerId);
  await new Promise(r => setTimeout(r, 500)); // mirror Go CLI: let port settle
  await startContainer(containerId);
}

export async function removeContainer(containerId: string): Promise<void> {
  // On Windows there's nothing to remove beyond killing the process —
  // start.ps1 stays so the slot can be restarted later via `ddsm start`.
  await stopContainer(containerId);
}

// --- Public API: read-side ------------------------------------------------

// Per-slot caches. GET /api/servers and the autosleep poller both call
// these for every slot; without a cache layer Windows fires a fresh
// powershell.exe each call, which is 500ms-2s per spawn. With caches, a
// burst of calls within the window returns instantly.
interface CacheEntry<T> { value: T; expires: number }
const infoCache = new Map<string, CacheEntry<ContainerInfo | null>>();
const statsCache = new Map<string, CacheEntry<ContainerStats | null>>();
const INFO_CACHE_MS = 2000;
const STATS_CACHE_MS = 5000;

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const e = map.get(key);
  if (e && e.expires > Date.now()) return e.value;
  return undefined;
}
function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expires: Date.now() + ttlMs });
}

export async function getContainerInfo(containerId: string): Promise<ContainerInfo | null> {
  let slotId: string;
  try { slotId = resolveSlotId(containerId); } catch { return null; }

  const cached = cacheGet(infoCache, slotId);
  if (cached !== undefined) return cached;

  const rec = readProcRecord(slotId);
  let status: string;
  let startedAt = "";
  if (!rec) {
    status = "exited";
  } else if (rec.pid === -1) {
    // startContainer wrote this marker just before triggering the task.
    // start.ps1 overwrites it with the real deadworks PID within ~2s.
    status = "starting";
    startedAt = rec.startedAt;
  } else {
    status = isPidAlive(rec.pid) ? "running" : "exited";
    startedAt = rec.startedAt;
  }

  const info: ContainerInfo = { id: containerId, status, state: status, startedAt };
  cacheSet(infoCache, slotId, info, INFO_CACHE_MS);
  return info;
}

export async function getContainerStats(containerId: string): Promise<ContainerStats | null> {
  let slotId: string;
  try { slotId = resolveSlotId(containerId); } catch { return null; }

  const cached = cacheGet(statsCache, slotId);
  if (cached !== undefined) return cached;

  const rec = readProcRecord(slotId);
  if (!rec || rec.pid <= 0) {
    cacheSet(statsCache, slotId, null, STATS_CACHE_MS);
    return null;
  }
  // Proc record now holds deadworks.exe's PID directly (not a wrapper).
  // Use wmic for a single fast call — no powershell host startup.
  try {
    const { stdout } = await execFileAsync(
      "wmic.exe",
      ["process", "where", `ProcessId=${rec.pid}`, "get", "WorkingSetSize,KernelModeTime,UserModeTime", "/format:csv"],
      { timeout: 4000 },
    );
    // CSV: Node,KernelModeTime,UserModeTime,WorkingSetSize
    const dataLine = stdout.split(/\r?\n/).find(l => /,\d+,\d+,\d+/.test(l));
    if (!dataLine) {
      cacheSet(statsCache, slotId, null, STATS_CACHE_MS);
      return null;
    }
    const cols = dataLine.split(",");
    const wsBytes = parseInt(cols[cols.length - 1], 10) || 0;
    const memoryMb = Math.round(wsBytes / 1024 / 1024);
    // CPU% needs a delta over time which we don't track here; report 0 to
    // keep the contract stable. (Future: sample twice over 1s and compute.)
    const result: ContainerStats = {
      cpuPercent: 0,
      memoryMb,
      memoryLimitMb: 0,
    };
    cacheSet(statsCache, slotId, result, STATS_CACHE_MS);
    return result;
  } catch {
    cacheSet(statsCache, slotId, null, STATS_CACHE_MS);
    return null;
  }
}

// --- Log streaming --------------------------------------------------------
//
// The logs/route.ts handler imports `docker` and calls
//   docker.getContainer(id).logs({ follow, stdout, stderr, tail })
// then parses the result as a Docker-multiplexed byte stream:
//   [stream_type(1), 0, 0, 0, size_be32(4)] + payload[size]
//
// On Windows there is no Docker, so we tail <slot>/Deadlock/dspawn.log
// (the same file the DSpawn-Logger plugin writes) and emit Docker-format
// frames so the existing parser works unchanged.

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = STDOUT_FRAME;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

class TailStream extends Readable {
  private fd: number | null = null;
  private offset = 0;
  private watcher: fs.FSWatcher | null = null;
  private closed = false;

  constructor(private readonly logPath: string, private readonly tailLines: number) {
    super();
  }

  override _read(): void {
    if (this.fd !== null) return;
    this.openAndTail();
  }

  private openAndTail() {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, "");
    try {
      this.fd = fs.openSync(this.logPath, "r");
    } catch (err) {
      this.push(frame(`[ddsm] cannot open ${this.logPath}\n`));
      this.push(null);
      return;
    }
    const st = fs.fstatSync(this.fd);

    // Seek so we emit roughly `tailLines` lines of backlog.
    const approxBytes = Math.max(0, this.tailLines * 200);
    this.offset = st.size > approxBytes ? st.size - approxBytes : 0;

    this.flushReadable();

    this.watcher = fs.watch(this.logPath, () => {
      if (!this.closed) this.flushReadable();
    });
  }

  private flushReadable() {
    if (this.fd === null || this.closed) return;
    try {
      const st = fs.fstatSync(this.fd);
      if (st.size <= this.offset) {
        // File rotated/truncated — reopen.
        if (st.size < this.offset) {
          this.offset = 0;
        } else {
          return;
        }
      }
      const len = Math.min(64 * 1024, st.size - this.offset);
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(this.fd, buf, 0, len, this.offset);
      this.offset += read;
      if (read > 0) this.push(frame(buf.slice(0, read).toString("utf8")));
    } catch {
      /* ignore transient read errors */
    }
  }

  destroy(error?: Error | null): this {
    this.closed = true;
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
    if (!this.destroyed) super.destroy(error ?? undefined);
    return this;
  }
}

interface ContainerHandle {
  logs(opts: { follow?: boolean; stdout?: boolean; stderr?: boolean; tail?: number; timestamps?: boolean }): Promise<Readable>;
}

/**
 * Stand-in for the dockerode client used by api/servers/[id]/logs/route.ts.
 * Only the `getContainer(id).logs(...)` path is implemented because that's
 * all the dashboard touches.
 */
export const docker = {
  getContainer(containerId: string): ContainerHandle {
    return {
      async logs(opts) {
        let slotId: string;
        try { slotId = resolveSlotId(containerId); }
        catch { slotId = containerId; } // best-effort; TailStream will yield an error frame
        const logPath = path.join(slotDir(slotId), "Deadlock", "dspawn.log");
        const tail = Math.max(0, opts.tail ?? 200);
        return new TailStream(logPath, tail);
      },
    };
  },
};
