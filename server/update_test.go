package server

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"v0.2.0", "0.1.1", true}, {"v0.1.10", "0.1.9", true}, {"v1.0", "0.9.9", true},
		{"v0.1.1", "0.1.1", false}, {"v0.1.0", "0.1.1", false}, {"v0.1.1", "v0.1.1.0", false},
	} {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func checkAgainst(t *testing.T, version, body string) updateInfo {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
	t.Cleanup(fake.Close)
	oldV, oldURL := Version, latestURL
	t.Cleanup(func() { Version, latestURL, updateOnce = oldV, oldURL, sync.Once{} })
	Version, latestURL, updateOnce = version, fake.URL, sync.Once{}
	return checkUpdate()
}

func TestCheckUpdate(t *testing.T) {
	u := checkAgainst(t, "0.1.1", `{"tag_name":"v0.2.0","html_url":"https://github.com/innacy/api-man/releases/tag/v0.2.0"}`)
	if !u.Available || u.Latest != "v0.2.0" {
		t.Fatalf("want update, got %+v", u)
	}
	if u := checkAgainst(t, "0.2.0", `{"tag_name":"v0.2.0","html_url":"https://github.com/innacy/api-man/releases/tag/v0.2.0"}`); u.Available {
		t.Fatalf("same version flagged: %+v", u)
	}
	// A response pointing anywhere else is ignored, so open-update can't be steered.
	if u := checkAgainst(t, "0.1.1", `{"tag_name":"v9.0.0","html_url":"https://evil.example/x"}`); u.Available || u.URL != "" {
		t.Fatalf("foreign URL accepted: %+v", u)
	}
	if u := checkAgainst(t, "dev", `{"tag_name":"v9.0.0","html_url":"https://github.com/innacy/api-man/releases/tag/v9.0.0"}`); u.Available {
		t.Fatalf("dev build checked: %+v", u)
	}
}
