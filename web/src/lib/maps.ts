// web/src/lib/maps.ts
//
// Enumerate Source 2 maps actually present on disk for a slot. Used by the
// server-settings dropdown so admins pick from real options instead of
// typing map names blind.

import fs from "fs";
import path from "path";
import { SERVERS_DIR } from "./config";

// A real, loadable map file is just `<name>.vpk` — backups, disabled
// variants (`bhop_colour.vpk.bak.pre-merge`, `bhop_emevaelx3.vpk.disabled`)
// have extra suffixes and must NOT show up in the dropdown.
const MAP_FILENAME = /^([A-Za-z0-9_]+)\.vpk$/;

// On Linux DDSM the game tree lives under `<slot>/merged/Deadlock/game`
// (overlayfs); on Windows DDSM and on Linux plain-dir mode it's
// `<slot>/Deadlock/game`. Try overlay first, fall back to plain.
export function deadlockGameDir(slotId: string): string {
  const overlayed = path.join(SERVERS_DIR, slotId, "merged", "Deadlock", "game");
  if (fs.existsSync(overlayed)) return overlayed;
  return path.join(SERVERS_DIR, slotId, "Deadlock", "game");
}

function listVpkBasenames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = MAP_FILENAME.exec(f);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Returns every map name installed for the given slot, sorted
 * alphabetically. Combines built-in maps and any installed
 * `citadel_addons/<addon>/maps/*.vpk` workshop maps.
 *
 * The names returned are exactly what `+map <name>` expects.
 */
export function listMapsForSlot(slotId: string): string[] {
  const game = deadlockGameDir(slotId);
  const result = new Set<string>();

  for (const m of listVpkBasenames(path.join(game, "citadel", "maps"))) {
    result.add(m);
  }

  const addonsDir = path.join(game, "citadel_addons");
  if (fs.existsSync(addonsDir)) {
    for (const entry of fs.readdirSync(addonsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const addonMaps = path.join(addonsDir, entry.name, "maps");
      for (const m of listVpkBasenames(addonMaps)) result.add(m);
    }
  }

  return Array.from(result).sort();
}
