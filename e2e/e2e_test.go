// Package e2e drives the real compiled apiperf binary (in -headless mode, so it
// runs on CI without a display) over HTTP: startup, embedded UI, data folder,
// send + history, a load run with live SSE events, the single-instance lock,
// shutdown, and persistence across a restart.
//
// Run: go test ./e2e   (needs port 7071 free: close the desktop app first)
package e2e

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const base = "http://localhost:7071"

// app is one running apiperf process; out collects its combined stdout/stderr.
type app struct {
	cmd *exec.Cmd
	out *syncBuf
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// dataEnv points every OS's per-user data folder at dir.
func dataEnv(dir string) []string {
	return append(os.Environ(), "XDG_DATA_HOME="+dir, "HOME="+dir, "APPDATA="+dir)
}

func start(t *testing.T, bin, data string) *app {
	t.Helper()
	a := &app{cmd: exec.Command(bin, "-headless"), out: &syncBuf{}}
	a.cmd.Env = dataEnv(data)
	a.cmd.Stdout, a.cmd.Stderr = a.out, a.out
	if err := a.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if res, err := http.Get(base + "/api/ping"); err == nil {
			res.Body.Close()
			unlockVault(t)
			return a
		}
		time.Sleep(100 * time.Millisecond)
	}
	a.cmd.Process.Kill()
	t.Fatalf("apiperf never answered /api/ping; output:\n%s", a.out)
	return nil
}

// unlockVault creates the master password on first launch, unlocks after
// that; the session cookie lands in http.DefaultClient's jar.
func unlockVault(t *testing.T) {
	t.Helper()
	if http.DefaultClient.Jar == nil {
		http.DefaultClient.Jar, _ = cookiejar.New(nil)
	}
	for _, p := range []string{"/api/vault/init", "/api/vault/unlock"} {
		res, err := http.Post(base+p, "application/json", strings.NewReader(`{"password":"e2e"}`))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			return
		}
	}
	t.Fatal("could not unlock the vault")
}

// stop shuts the app down the way a user does (Ctrl+C) and checks it exits
// cleanly. Windows has no SIGINT for child processes, so it is killed there.
func (a *app) stop(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		a.cmd.Process.Kill()
		a.cmd.Wait()
		return
	}
	a.cmd.Process.Signal(os.Interrupt)
	done := make(chan error, 1)
	go func() { done <- a.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("unclean exit: %v; output:\n%s", err, a.out)
		}
	case <-time.After(15 * time.Second):
		a.cmd.Process.Kill()
		t.Fatalf("apiperf did not exit within 15s of Ctrl+C; output:\n%s", a.out)
	}
	if !strings.Contains(a.out.String(), "shutting down") {
		t.Fatalf("no clean-shutdown log; output:\n%s", a.out)
	}
}

func getJSON(t *testing.T, path string, v any) {
	t.Helper()
	res, err := http.Get(base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("GET %s: %d %s", path, res.StatusCode, b)
	}
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
}

func postJSON(t *testing.T, path, body string, v any) {
	t.Helper()
	res, err := http.Post(base+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 && res.StatusCode != 201 {
		t.Fatalf("POST %s: %d %s", path, res.StatusCode, b)
	}
	if v != nil {
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatalf("POST %s: %v (%s)", path, err, b)
		}
	}
}

func TestBinary(t *testing.T) {
	if res, err := http.Get(base + "/api/ping"); err == nil {
		res.Body.Close()
		t.Fatal("port 7071 is already in use: close API-Man / apiperf before running e2e tests")
	}

	tmp := t.TempDir()
	bin := filepath.Join(tmp, "apiperf")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-tags", "webkit2_41", "-o", bin, ".")
	build.Dir = ".."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	data := filepath.Join(tmp, "data")
	a := start(t, bin, data)
	defer func() { a.cmd.Process.Kill() }() // safety net if a check fails mid-way

	t.Run("embedded UI is served", func(t *testing.T) {
		for _, p := range []string{"/", "/app.js", "/codegen.js"} {
			res, err := http.Get(base + p)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode != 200 || len(b) < 100 {
				t.Fatalf("GET %s: %d, %d bytes", p, res.StatusCode, len(b))
			}
		}
	})

	t.Run("foreign Host is rejected", func(t *testing.T) {
		req, _ := http.NewRequest("GET", base+"/api/runs", nil)
		req.Host = "evil.example"
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("got %d, want 403", res.StatusCode)
		}
	})

	t.Run("databases live in the per-user data folder", func(t *testing.T) {
		var found []string
		filepath.Walk(data, func(p string, _ os.FileInfo, _ error) error {
			if strings.HasSuffix(p, ".db") {
				found = append(found, filepath.Base(p))
			}
			return nil
		})
		if strings.Join(found, ",") != "apiperf.db,requests.db" {
			t.Fatalf("got %v under %s", found, data)
		}
	})

	t.Run("second instance refuses to start", func(t *testing.T) {
		out, err := exec.Command(bin, "-headless").CombinedOutput()
		if err == nil || !strings.Contains(string(out), "already running") {
			t.Fatalf("err=%v output=%s", err, out)
		}
	})

	t.Run("send records history", func(t *testing.T) {
		var res struct {
			Status int    `json:"status"`
			Body   string `json:"body"`
		}
		postJSON(t, "/api/send", fmt.Sprintf(`{"method":"GET","url":%q}`, target.URL+"/hello"), &res)
		if res.Status != 200 {
			t.Fatalf("send status %d", res.Status)
		}
		var hist []struct{ URL string }
		getJSON(t, "/api/history", &hist)
		if len(hist) != 1 || hist[0].URL != target.URL+"/hello" {
			t.Fatalf("history = %+v", hist)
		}
	})

	var runID int64
	t.Run("load run completes with live events", func(t *testing.T) {
		// Subscribe before starting so the first events aren't missed.
		es, err := http.Get(base + "/api/events")
		if err != nil {
			t.Fatal(err)
		}
		defer es.Body.Close()
		events := make(chan string, 256)
		go func() {
			sc := bufio.NewScanner(es.Body)
			for sc.Scan() {
				if strings.HasPrefix(sc.Text(), "event:") || strings.HasPrefix(sc.Text(), "data:") {
					events <- sc.Text()
				}
			}
			close(events)
		}()

		var created struct {
			RunID int64 `json:"runId"`
		}
		postJSON(t, "/api/runs", fmt.Sprintf(`{"curl":"curl %s","stages":[{"requests":200,"concurrency":4}]}`, target.URL), &created)
		runID = created.RunID
		postJSON(t, fmt.Sprintf("/api/runs/%d/start", runID), `{}`, nil)

		var run struct {
			Status string `json:"status"`
		}
		for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(200 * time.Millisecond) {
			getJSON(t, fmt.Sprintf("/api/runs/%d", runID), &run)
			if run.Status != "pending" && run.Status != "running" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("run %d still %s after 60s", runID, run.Status)
			}
		}
		if run.Status != "completed" {
			t.Fatalf("run ended %q, want completed", run.Status)
		}
		select {
		case _, ok := <-events:
			if !ok {
				t.Fatal("SSE stream closed with no events")
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no SSE events during the run")
		}
	})

	a.stop(t)

	t.Run("history survives a restart", func(t *testing.T) {
		a = start(t, bin, data)
		var runs []struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		}
		getJSON(t, "/api/runs", &runs)
		if len(runs) != 1 || runs[0].ID != runID || runs[0].Status != "completed" {
			t.Fatalf("runs after restart = %+v", runs)
		}
		var hist []struct{ URL string }
		getJSON(t, "/api/history", &hist)
		if len(hist) != 1 {
			t.Fatalf("send history after restart = %+v", hist)
		}
		a.stop(t)
	})
}
