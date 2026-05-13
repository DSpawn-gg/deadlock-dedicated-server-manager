//go:build linux

package ddsm

import (
	"context"
	"fmt"

	"github.com/docker/docker/api/types/image"
)

func checkDocker() CheckResult {
	_, err := DockerClient().Ping(context.Background())
	if err != nil {
		return CheckResult{"Docker daemon", "fail", fmt.Sprintf("Cannot connect: %v. Is Docker running?", err)}
	}
	return CheckResult{"Docker daemon", "pass", "Connected via /var/run/docker.sock"}
}

func checkImage() CheckResult {
	ctx := context.Background()
	images, err := DockerClient().ImageList(ctx, image.ListOptions{})
	if err != nil {
		return CheckResult{"Docker image", "fail", fmt.Sprintf("Cannot list images: %v", err)}
	}

	target := Cfg.DockerImage
	for _, img := range images {
		for _, tag := range img.RepoTags {
			if tag == target+":latest" || tag == target {
				return CheckResult{"Docker image", "pass", fmt.Sprintf("Image '%s' found", target)}
			}
		}
	}
	return CheckResult{"Docker image", "fail", fmt.Sprintf("Image '%s' not found. Build it first.", target)}
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
			results = append(results, CheckResult{name, "warn", "No container ID in database"})
			continue
		}

		info, err := GetContainerInfo(s.ContainerID.String)
		if err != nil {
			results = append(results, CheckResult{name, "fail", fmt.Sprintf("Container %s not found", s.ContainerID.String[:12])})
			continue
		}

		if info.State == "running" {
			_, err := QueryServerPlayers(s.Port)
			if err != nil {
				results = append(results, CheckResult{name, "warn", fmt.Sprintf("Running but RCON failed: %v", err)})
			} else {
				results = append(results, CheckResult{name, "pass", "Running, RCON OK"})
			}
		} else {
			results = append(results, CheckResult{name, "pass", fmt.Sprintf("Container state: %s", info.State)})
		}
	}
	return results
}
