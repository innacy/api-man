//go:build !windows

package main

import "syscall"

// raiseFDLimit lifts the soft open-files limit to the hard limit so
// high-concurrency stages don't die on EMFILE.
func raiseFDLimit() {
	var l syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &l); err == nil {
		l.Cur = l.Max
		_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &l)
	}
}
