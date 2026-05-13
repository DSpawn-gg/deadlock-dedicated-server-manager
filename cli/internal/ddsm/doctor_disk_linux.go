//go:build linux

package ddsm

import "syscall"

// getDiskFreeGB returns the free space in GB available to non-superusers on
// the filesystem containing path.
func getDiskFreeGB(path string) (float64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return float64(stat.Bavail*uint64(stat.Bsize)) / 1024 / 1024 / 1024, nil
}
