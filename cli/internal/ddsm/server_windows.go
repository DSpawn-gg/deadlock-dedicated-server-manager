//go:build windows

package ddsm

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// Windows backend overview
//
// On Linux, DDSM manages each gameserver as a Docker container — the
// container's ID lives in servers.container_id. On Windows the same column
// stores a PID-as-string. We keep the database schema identical so the web
// dashboard works unchanged across platforms; only the meaning of
// container_id varies.
//
// All the slot's files live at Cfg.ServersDir/<id>/Deadlock/. The slot's
// generated start.ps1 lives at Cfg.ServersDir/<id>/start.ps1. A small
// JSON record at Cfg.ServersDir/<id>/.ddsm-process.json caches PID +
// start time so we can re-attach after a DDSM restart.

// ------- Process record persistence ---------------------------------------

type winProcRecord struct {
	PID       int       `json:"pid"`
	StartedAt time.Time `json:"started_at"`
	Port      int       `json:"port"`
}

func processRecordPath(serverID string) string {
	return filepath.Join(Cfg.ServersDir, serverID, ".ddsm-process.json")
}

func writeProcessRecord(serverID string, rec winProcRecord) error {
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(processRecordPath(serverID), b, 0644)
}

func readProcessRecord(serverID string) (*winProcRecord, error) {
	b, err := os.ReadFile(processRecordPath(serverID))
	if err != nil {
		return nil, err
	}
	var rec winProcRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func isPidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(0x1000, false, uint32(pid)) // PROCESS_QUERY_LIMITED_INFORMATION
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

// ------- Overlay/base stubs (no overlayfs on Windows) ---------------------

func BaseInstalled() bool                   { return false }
func UsesOverlay(serverID string) bool      { return false }
func IsOverlayMounted(serverID string) bool { return false }
func MergedPath(serverID string) string {
	return filepath.Join(Cfg.ServersDir, serverID)
}
func SetupOverlayDirs(serverID string) error { return nil }
func MountOverlay(serverID string) error     { return nil }
func UnmountOverlay(serverID string) error   { return nil }
func MountAllOverlays()                      {}

// ------- Docker-named stubs (no Docker on Windows) ------------------------

type fakeDockerClient struct{}

// DockerClient is referenced from cross-platform code paths. On Windows we
// return a sentinel so that anything which tries to call Ping/ImageList/etc.
// surfaces a clear compile error if it isn't already build-tagged !windows.
func DockerClient() *fakeDockerClient { return &fakeDockerClient{} }

// StreamLogs follows the slot's dspawn.log file (the Linux equivalent reads
// from `docker logs`). containerID is interpreted as a PID-as-string; the
// owning slot is found by reverse lookup in the servers table.
func StreamLogs(containerID string, tail int, done <-chan struct{}) (<-chan string, error) {
	pid, _ := strconv.Atoi(containerID)
	servers, err := ListServers()
	if err != nil {
		return nil, err
	}
	var slotID string
	for _, s := range servers {
		if s.ContainerID.Valid && s.ContainerID.String == containerID {
			slotID = s.ID
			break
		}
	}
	if slotID == "" {
		return nil, fmt.Errorf("no server slot found for pid %d", pid)
	}
	logPath := filepath.Join(Cfg.ServersDir, slotID, "Deadlock", "dspawn.log")

	ch := make(chan string, 256)
	go func() {
		defer close(ch)
		f, err := os.Open(logPath)
		if err != nil {
			ch <- fmt.Sprintf("[ddsm] cannot open %s: %v", logPath, err)
			return
		}
		defer f.Close()

		if tail > 0 {
			info, _ := f.Stat()
			off := int64(tail) * 200
			if info != nil && info.Size() > off {
				f.Seek(info.Size()-off, 0)
			}
		} else {
			f.Seek(0, 2)
		}

		buf := make([]byte, 4096)
		acc := []byte{}
		for {
			select {
			case <-done:
				return
			default:
			}
			n, err := f.Read(buf)
			if n > 0 {
				acc = append(acc, buf[:n]...)
				for {
					idx := -1
					for i, c := range acc {
						if c == '\n' {
							idx = i
							break
						}
					}
					if idx < 0 {
						break
					}
					select {
					case ch <- string(acc[:idx]):
					case <-done:
						return
					}
					acc = acc[idx+1:]
				}
			}
			if err != nil {
				time.Sleep(250 * time.Millisecond)
			}
		}
	}()
	return ch, nil
}

func WaitForContainerRunning(containerID string, timeout time.Duration) error {
	pid, err := strconv.Atoi(containerID)
	if err != nil {
		return fmt.Errorf("invalid pid %q: %w", containerID, err)
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if isPidAlive(pid) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("server pid %d did not become running within %s", pid, timeout)
}

// ------- Container CRUD facade ---------------------------------------------

// CreateContainer here is a misnomer kept for cross-platform API parity:
// it writes the slot's start.ps1 and returns a placeholder ID (the slot
// name). StartContainer later replaces it with the real PID.
func CreateContainer(name string, port int, env map[string]string, volumePath string, useOverlay bool) (string, error) {
	if err := os.MkdirAll(volumePath, 0755); err != nil {
		return "", err
	}
	scriptPath := filepath.Join(volumePath, "start.ps1")
	body := renderWindowsStartScript(volumePath, port, env)
	if err := os.WriteFile(scriptPath, []byte(body), 0755); err != nil {
		return "", err
	}
	return name, nil
}

var startMu sync.Mutex

// StartContainer spawns the slot's start.ps1 and stores the new PID in the
// servers.container_id column.
func StartContainer(containerID string) error {
	servers, err := ListServers()
	if err != nil {
		return err
	}
	var slotID, slotName string
	for _, s := range servers {
		if s.ContainerID.Valid && s.ContainerID.String == containerID {
			slotID = s.ID
			slotName = s.Name
			break
		}
	}
	if slotID == "" {
		for _, s := range servers {
			if fmt.Sprintf("deadlock-%s", s.ID[:8]) == containerID {
				slotID = s.ID
				slotName = s.Name
				break
			}
		}
	}
	if slotID == "" {
		return fmt.Errorf("no slot maps to container id %q", containerID)
	}

	startMu.Lock()
	defer startMu.Unlock()

	scriptPath := filepath.Join(Cfg.ServersDir, slotID, "start.ps1")
	if _, err := os.Stat(scriptPath); err != nil {
		return fmt.Errorf("start.ps1 missing for slot %s (%s): %w", slotName, slotID, err)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	cmd.Dir = filepath.Join(Cfg.ServersDir, slotID)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn powershell: %w", err)
	}
	go func() { _ = cmd.Wait() }()

	rec := winProcRecord{PID: cmd.Process.Pid, StartedAt: time.Now()}
	if row, _ := GetServer(slotID); row != nil {
		rec.Port = row.Port
	}
	if err := writeProcessRecord(slotID, rec); err != nil {
		return err
	}
	return UpdateServerContainerID(slotID, strconv.Itoa(cmd.Process.Pid))
}

func StopContainer(containerID string) error {
	pid, err := strconv.Atoi(containerID)
	if err != nil || pid <= 0 {
		return nil
	}
	out, err := exec.Command("taskkill.exe", "/F", "/T", "/PID", strconv.Itoa(pid)).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "not found") && !strings.Contains(string(out), "not running") {
		return fmt.Errorf("taskkill: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

func RestartContainer(containerID string) error {
	if err := StopContainer(containerID); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	return StartContainer(containerID)
}

func RemoveContainer(containerID string) error {
	return StopContainer(containerID)
}

func GetContainerInfo(containerID string) (*ContainerInfo, error) {
	pid, _ := strconv.Atoi(containerID)
	state := "exited"
	if isPidAlive(pid) {
		state = "running"
	}
	startedAt := ""
	servers, _ := ListServers()
	for _, s := range servers {
		if s.ContainerID.Valid && s.ContainerID.String == containerID {
			if rec, err := readProcessRecord(s.ID); err == nil {
				startedAt = rec.StartedAt.Format(time.RFC3339Nano)
			}
			break
		}
	}
	return &ContainerInfo{ID: containerID, Status: state, State: state, StartedAt: startedAt}, nil
}

func GetContainerStats(containerID string) (*ContainerStats, error) {
	pid, err := strconv.Atoi(containerID)
	if err != nil || pid <= 0 {
		return &ContainerStats{}, nil
	}
	psCmd := fmt.Sprintf(
		`$child = Get-CimInstance Win32_Process -Filter "ParentProcessId=%d AND Name='deadlock.exe'" -ErrorAction SilentlyContinue; if (-not $child) { $child = Get-Process -Id %d -ErrorAction SilentlyContinue }; if ($child -is [array]) { $child = $child[0] }; if ($child) { "{0:F2},{1:F2}" -f ([double]$child.CPU), ([double]($child.WorkingSet64 / 1MB)) }`,
		pid, pid,
	)
	out, err := exec.CommandContext(context.Background(), "powershell.exe", "-NoProfile", "-Command", psCmd).Output()
	if err != nil {
		return &ContainerStats{}, nil
	}
	parts := strings.Split(strings.TrimSpace(string(out)), ",")
	if len(parts) != 2 {
		return &ContainerStats{}, nil
	}
	cpu, _ := strconv.ParseFloat(parts[0], 64)
	mem, _ := strconv.ParseFloat(parts[1], 64)
	return &ContainerStats{CPUPercent: cpu, MemoryMB: mem, MemoryLimitMB: 0}, nil
}

// ServerVolumePath returns the slot's root directory on disk.
func ServerVolumePath(serverID string) string {
	return filepath.Join(Cfg.ServersDir, serverID)
}

// ------- High-level server lifecycle ---------------------------------------

func CreateServer(opts ServerCreateOpts) (*ServerRow, error) {
	return createServerWindows(opts, nil)
}

func CreateServerWithProgress(opts ServerCreateOpts, progress chan<- string) (*ServerRow, error) {
	defer close(progress)
	return createServerWindows(opts, progress)
}

func createServerWindows(opts ServerCreateOpts, progress chan<- string) (*ServerRow, error) {
	id := uuid.New().String()
	volumePath := filepath.Join(Cfg.ServersDir, id)
	deadlockDir := filepath.Join(volumePath, "Deadlock")

	if progress != nil {
		progress <- "Setting up slot directory..."
	}
	if err := os.MkdirAll(deadlockDir, 0755); err != nil {
		return nil, fmt.Errorf("create slot dir: %w", err)
	}

	if progress != nil {
		progress <- "Writing start.ps1..."
	}
	env := map[string]string{
		"PORT":            fmt.Sprintf("%d", opts.Port),
		"MAP":             opts.Map,
		"SERVER_PASSWORD": opts.Password,
	}
	scriptPath := filepath.Join(volumePath, "start.ps1")
	if err := os.WriteFile(scriptPath, []byte(renderWindowsStartScript(volumePath, opts.Port, env)), 0755); err != nil {
		return nil, fmt.Errorf("write start.ps1: %w", err)
	}

	if progress != nil {
		progress <- "Saving to database..."
	}
	server := &ServerRow{
		ID:          id,
		Name:        opts.Name,
		Port:        opts.Port,
		Map:         opts.Map,
		Password:    opts.Password,
		SteamLogin:  opts.SteamLogin,
		SteamPass:   opts.SteamPass,
		Steam2FA:    opts.Steam2FA,
		SkipUpdate:  1,
		ContainerID: sql.NullString{String: fmt.Sprintf("deadlock-%s", id[:8]), Valid: true},
	}
	if err := InsertServer(server); err != nil {
		return nil, fmt.Errorf("insert server: %w", err)
	}

	if progress != nil {
		progress <- "Server created (call ddsm start to launch)."
	}
	return server, nil
}

func DeleteServer(id string, deleteFiles bool) error {
	server, err := GetServer(id)
	if err != nil {
		return err
	}
	if server == nil {
		return fmt.Errorf("server not found: %s", id)
	}
	if server.ContainerID.Valid {
		_ = StopContainer(server.ContainerID.String)
	}
	if deleteFiles {
		os.RemoveAll(filepath.Join(Cfg.ServersDir, id))
	}
	return DeleteServerRow(id)
}

func StartServer(id string) error {
	server, err := GetServer(id)
	if err != nil || server == nil {
		return fmt.Errorf("server not found: %s", id)
	}
	if !server.ContainerID.Valid {
		return fmt.Errorf("server has no container id: %s", id)
	}
	return StartContainer(server.ContainerID.String)
}

func StopServer(id string) error {
	server, err := GetServer(id)
	if err != nil || server == nil {
		return fmt.Errorf("server not found: %s", id)
	}
	if !server.ContainerID.Valid {
		return nil
	}
	return StopContainer(server.ContainerID.String)
}

func RestartServer(id string) error {
	if err := StopServer(id); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	return StartServer(id)
}

func GetServerStatus(server *ServerRow) *ServerStatus {
	status := &ServerStatus{ServerRow: *server, Status: "unknown"}
	if !server.ContainerID.Valid {
		return status
	}
	info, err := GetContainerInfo(server.ContainerID.String)
	if err != nil {
		return status
	}
	status.Status = info.State
	status.StartedAt = info.StartedAt
	if info.State == "running" {
		if stats, err := GetContainerStats(server.ContainerID.String); err == nil {
			status.Stats = stats
		}
		if players, err := QueryServerPlayers(server.Port); err == nil {
			status.Players = players.Players
			status.MaxPlayers = players.MaxPlayers
		}
	}
	return status
}

func ListServerStatuses() ([]*ServerStatus, error) {
	servers, err := ListServers()
	if err != nil {
		return nil, err
	}
	out := make([]*ServerStatus, 0, len(servers))
	for i := range servers {
		out = append(out, GetServerStatus(&servers[i]))
	}
	return out, nil
}

func ForEachServer(action func(string) error) error {
	servers, err := ListServers()
	if err != nil {
		return err
	}
	for _, s := range servers {
		if err := action(s.ID); err != nil {
			fmt.Fprintf(os.Stderr, "  %s: %v\n", s.Name, err)
		}
	}
	return nil
}

// UpdateBase is a no-op on Windows. Game files are populated by an out-of-
// band rsync from the upstream Linux box, not SteamCMD inside a container.
func UpdateBase(steamLogin, steamPass, steam2FA string) error {
	return fmt.Errorf("UpdateBase is not supported on the Windows backend; populate %s manually via rsync or SteamCMD", Cfg.BaseDir)
}

func UpdateServerAndRecreate(id, name, mapName, password string) error {
	server, err := GetServer(id)
	if err != nil || server == nil {
		return fmt.Errorf("server not found: %s", id)
	}
	wasRunning := false
	if server.ContainerID.Valid {
		info, _ := GetContainerInfo(server.ContainerID.String)
		if info != nil && info.State == "running" {
			wasRunning = true
			_ = StopContainer(server.ContainerID.String)
		}
	}
	if err := UpdateServerFields(id, name, mapName, password); err != nil {
		return err
	}
	env := map[string]string{
		"PORT":            fmt.Sprintf("%d", server.Port),
		"MAP":             mapName,
		"SERVER_PASSWORD": password,
	}
	volumePath := filepath.Join(Cfg.ServersDir, id)
	if err := os.WriteFile(
		filepath.Join(volumePath, "start.ps1"),
		[]byte(renderWindowsStartScript(volumePath, server.Port, env)),
		0755,
	); err != nil {
		return err
	}
	if wasRunning {
		return StartServer(id)
	}
	return nil
}
