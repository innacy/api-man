package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"apiperf/orch"
	"apiperf/server"
	"apiperf/store"
)

func main() {
	headless := flag.Bool("headless", false, "serve http://localhost:7071 only; don't open the app window")
	flag.Parse()
	raiseFDLimit()

	// Acquire the port first: it's the process mutex for "am I the only
	// apiperf running." Binding must happen before we touch the store —
	// otherwise a second instance started while a first is mid-run can
	// run the stale-run sweep and mark the first instance's live run
	// 'killed' before discovering the port is already taken.
	ln, err := net.Listen("tcp", "localhost:7071")
	if err != nil {
		log.Fatalf("apiperf: cannot bind localhost:7071 (already running?): %v", err)
	}

	st, err := store.Open(filepath.Join(dataDir(), "apiperf.db"))
	if err != nil {
		ln.Close()
		log.Fatal(err)
	}
	if n, err := st.MarkStaleRunsKilled(); err != nil {
		log.Printf("main: MarkStaleRunsKilled: %v", err)
	} else if n > 0 {
		log.Printf("main: marked %d stale running run(s) as killed", n)
	}

	lib, err := store.OpenLibrary(filepath.Join(dataDir(), "requests.db"))
	if err != nil {
		ln.Close()
		log.Fatal(err)
	}

	hub := server.NewHub()
	o := orch.New(st, hub.Emit)
	srv := &http.Server{Handler: server.New(st, lib, o, hub)}

	var once sync.Once
	shutdown := func() {
		once.Do(func() {
			log.Println("apiperf: shutting down...")
			if running, id := o.Running(); running {
				o.Stop(id)
				// Give the run goroutine time to flush its buffered samples and
				// mark the run 'killed' before we close the store.
				for i := 0; i < 100; i++ {
					if running, _ := o.Running(); !running {
						break
					}
					time.Sleep(50 * time.Millisecond)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil {
				log.Printf("main: server shutdown: %v", err)
			}
		})
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigCh; shutdown() }()

	served := make(chan struct{})
	go func() {
		defer close(served)
		log.Println("apiperf listening on http://localhost:7071")
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("main: serve: %v", err)
		}
	}()
	if !*headless {
		// Window closed (or failed to open) → same clean stop as Ctrl+C.
		if err := runWindow(); err != nil {
			log.Printf("main: window: %v (use -headless to run browser-only)", err)
		}
		shutdown()
	}
	<-served
	if err := st.Close(); err != nil {
		log.Printf("main: store close: %v", err)
	}
	if err := lib.Close(); err != nil {
		log.Printf("main: library close: %v", err)
	}
}

// dataDir is the per-user folder holding apiperf.db and requests.db:
// $XDG_DATA_HOME/apiperf (else ~/.local/share/apiperf) on Linux,
// %AppData%\apiperf on Windows, ~/Library/Application Support/apiperf on
// macOS. Installed apps can't write next to the binary.
func dataDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" && runtime.GOOS == "linux" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("apiperf: cannot find home directory: %v", err)
		}
		base = filepath.Join(home, ".local", "share")
	}
	if base == "" {
		var err error
		if base, err = os.UserConfigDir(); err != nil {
			log.Fatalf("apiperf: cannot find user config directory: %v", err)
		}
	}
	dir := filepath.Join(base, "apiperf")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Fatalf("apiperf: cannot create %s: %v", dir, err)
	}
	return dir
}
