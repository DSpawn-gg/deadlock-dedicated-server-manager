//go:build windows

package ddsm

import "fmt"

func checkDocker() CheckResult {
	return CheckResult{"Docker daemon", "pass", "n/a on Windows backend (native deadlock.exe processes)"}
}

func checkImage() CheckResult {
	return CheckResult{"Docker image", "pass", "n/a on Windows backend"}
}

func checkServers() []CheckResult {
	servers, err := ListServers()
	if err != nil {
		return []CheckResult{{"Server database", "fail", fmt.Sprintf("Cannot read: %v", err)}}
	}
	if len(servers) == 0 {
		return []CheckResult{{"Servers", "pass", "No servers configured"}}
	}
	var results []CheckResult
	for _, s := range servers {
		name := fmt.Sprintf("Server '%s' (port %d)", s.Name, s.Port)
		if !s.ContainerID.Valid {
			results = append(results, CheckResult{name, "warn", "No process id in database"})
			continue
		}
		info, err := GetContainerInfo(s.ContainerID.String)
		if err != nil || info == nil {
			results = append(results, CheckResult{name, "warn", fmt.Sprintf("PID %s lookup failed", s.ContainerID.String)})
			continue
		}
		if info.State == "running" {
			if _, err := QueryServerPlayers(s.Port); err != nil {
				results = append(results, CheckResult{name, "warn", fmt.Sprintf("Running but RCON failed: %v", err)})
			} else {
				results = append(results, CheckResult{name, "pass", "Running, RCON OK"})
			}
		} else {
			results = append(results, CheckResult{name, "pass", fmt.Sprintf("State: %s", info.State)})
		}
	}
	return results
}
