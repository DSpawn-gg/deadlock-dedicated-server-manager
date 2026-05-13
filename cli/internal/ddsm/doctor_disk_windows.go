//go:build windows

package ddsm

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// getDiskFreeGB returns the free space in GB available to the calling user on
// the volume containing path, using the Win32 GetDiskFreeSpaceExW API.
func getDiskFreeGB(path string) (float64, error) {
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var freeBytesAvailable uint64
	r, _, e := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		0,
		0,
	)
	if r == 0 {
		return 0, e
	}
	return float64(freeBytesAvailable) / 1024 / 1024 / 1024, nil
}
