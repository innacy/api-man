package server

import (
	"net/http"
	"net/http/cookiejar"
	"path/filepath"
	"strings"
	"testing"
)

func TestVaultGate(t *testing.T) {
	VaultPath = filepath.Join(t.TempDir(), "vault.json")
	defer func() { VaultPath = "" }()
	ts, _ := newTestServer(t)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	do := func(method, path, body string) int {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	steps := []struct {
		m, p, b string
		want    int
	}{
		{"GET", "/api/runs", "", 401},
		{"POST", "/api/vault/unlock", `{"password":"x"}`, 409},
		{"POST", "/api/vault/init", `{"password":"pw"}`, 200},
		{"POST", "/api/vault/init", `{"password":"pw"}`, 409},
		{"GET", "/api/runs", "", 200},
	}
	for _, s := range steps {
		if got := do(s.m, s.p, s.b); got != s.want {
			t.Fatalf("%s %s = %d, want %d", s.m, s.p, got, s.want)
		}
	}
	c.Jar, _ = cookiejar.New(nil) // new launch/session
	for _, s := range []struct {
		m, p, b string
		want    int
	}{
		{"GET", "/api/runs", "", 401},
		{"POST", "/api/vault/unlock", `{"password":"bad"}`, 401},
		{"POST", "/api/vault/unlock", `{"password":"pw"}`, 200},
		{"GET", "/api/runs", "", 200},
		{"POST", "/api/vault/reset", `{}`, 200},
		{"GET", "/api/runs", "", 401},
		{"POST", "/api/vault/init", `{"password":"new"}`, 200},
	} {
		if got := do(s.m, s.p, s.b); got != s.want {
			t.Fatalf("%s %s = %d, want %d", s.m, s.p, got, s.want)
		}
	}
}
