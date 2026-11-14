package main

// raiseFDLimit is a no-op: Windows has no per-process open-files rlimit.
func raiseFDLimit() {}
