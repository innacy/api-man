package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version is the running build's version, set by main from -ldflags
// "-X main.version=..." (CI stamps the release tag). "dev" skips the check.
var Version = "dev"

const releasesAPI = "https://api.github.com/repos/innacy/api-man/releases/latest"
const releasesPage = "https://github.com/innacy/api-man/releases/"

type updateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	URL       string `json:"url,omitempty"`
	Available bool   `json:"available"`
}

// ponytail: checked once per process (users restart the app often enough);
// add a TTL if it ever runs for weeks.
var (
	updateOnce sync.Once
	update     updateInfo
	latestURL  = releasesAPI // var so tests can point it at a fake server
)

func checkUpdate() updateInfo {
	updateOnce.Do(func() {
		update = updateInfo{Current: Version}
		if Version == "dev" {
			return
		}
		// Generous: slow DNS is common, and the UI never waits on this.
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "GET", latestURL, nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			log.Printf("update check: %v", err)
			return // offline: no banner
		}
		defer res.Body.Close()
		var rel struct {
			Tag string `json:"tag_name"`
			URL string `json:"html_url"`
		}
		if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&rel) != nil {
			return
		}
		// Only ever link to this repo's releases, whatever the response says.
		if !strings.HasPrefix(rel.URL, releasesPage) {
			return
		}
		update.Latest, update.URL = rel.Tag, rel.URL
		update.Available = newer(rel.Tag, Version)
	})
	return update
}

// newer reports whether version a (e.g. "v0.2.0") is greater than b.
// Non-numeric parts compare as 0.
func newer(a, b string) bool {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func handleUpdate(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, checkUpdate())
}

// handleOpenUpdate opens the latest release page in the system browser: the
// desktop window can't open new tabs. It only opens the URL it validated
// itself, never one from the request.
func handleOpenUpdate(w http.ResponseWriter, r *http.Request) {
	u := checkUpdate()
	if !u.Available {
		writeError(w, http.StatusNotFound, "no update available")
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u.URL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u.URL)
	default:
		cmd = exec.Command("xdg-open", u.URL)
	}
	if err := cmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, "cannot open browser: "+err.Error())
		return
	}
	go cmd.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
