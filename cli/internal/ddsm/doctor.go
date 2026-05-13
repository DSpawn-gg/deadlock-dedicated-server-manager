package ddsm

import (
	"fmt"
	"os"
)

type CheckResult struct {
	Name   string
	Status string // "pass", "fail", "warn"
	Detail string
}

func RunDoctor() []CheckResult {
	var results []CheckResult

	results = append(results, checkDocker())
	results = append(results, checkImage())
	results = append(results, checkDiskSpace())
	results = append(results, checkServers()...)

	return results
}

func checkDiskSpace() CheckResult {
	freeGB, err := getDiskFreeGB(Cfg.ServersDir)
	if err != nil {
		if os.IsNotExist(err) {
			return CheckResult{"Disk space", "warn", fmt.Sprintf("Servers dir '%s' does not exist yet", Cfg.ServersDir)}
		}
		return CheckResult{"Disk space", "fail", fmt.Sprintf("Cannot stat: %v", err)}
	}
	if freeGB < 5 {
		return CheckResult{"Disk space", "warn", fmt.Sprintf("%.1f GB free at %s (recommend 5+ GB)", freeGB, Cfg.ServersDir)}
	}
	return CheckResult{"Disk space", "pass", fmt.Sprintf("%.1f GB free at %s", freeGB, Cfg.ServersDir)}
}

func PrintDoctorResults(results []CheckResult) {
	for _, r := range results {
		var icon string
		switch r.Status {
		case "pass":
			icon = "✓"
		case "fail":
			icon = "✗"
		case "warn":
			icon = "!"
		}
		fmt.Printf("  [%s] %s — %s\n", icon, r.Name, r.Detail)
	}

	fails := 0
	for _, r := range results {
		if r.Status == "fail" {
			fails++
		}
	}
	if fails > 0 {
		fmt.Printf("\n  %d check(s) failed.\n", fails)
	} else {
		fmt.Println("\n  All checks passed.")
	}
}
