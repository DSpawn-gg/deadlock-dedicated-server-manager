package ddsm

// ContainerInfo describes the runtime state of a managed server process.
// Despite the historical name, the value is a process descriptor on Windows
// (where "container" is a PID) and a Docker container ID on Linux.
type ContainerInfo struct {
	ID        string
	Status    string
	State     string // "running" | "exited" | "created" | "unknown"
	StartedAt string
}

// ContainerStats describes resource usage for a managed server process.
type ContainerStats struct {
	CPUPercent    float64
	MemoryMB      float64
	MemoryLimitMB float64
}

// ServerCreateOpts captures everything an operator needs to provide when
// creating a new server slot.
type ServerCreateOpts struct {
	Name       string
	Port       int
	Map        string
	Password   string
	SteamLogin string
	SteamPass  string
	Steam2FA   string
}

// ServerStatus is the runtime view of a ServerRow.
type ServerStatus struct {
	ServerRow
	Status     string
	StartedAt  string
	Stats      *ContainerStats
	Players    int
	MaxPlayers int
}
