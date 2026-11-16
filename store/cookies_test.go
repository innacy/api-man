package store

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func names(cs []*http.Cookie) string {
	var s []string
	for _, c := range cs {
		s = append(s, c.Name+"="+c.Value)
	}
	return strings.Join(s, "; ")
}

func TestCookieJarRules(t *testing.T) {
	l, _ := openLib(t)
	u := func(s string) *url.URL { p, _ := url.Parse(s); return p }
	l.SetCookies(u("https://api.example.com/auth/login"), []*http.Cookie{
		{Name: "host", Value: "1"},                                   // host-only, default path /auth
		{Name: "dom", Value: "2", Domain: ".example.com", Path: "/"}, // whole domain
		{Name: "sec", Value: "3", Path: "/", Secure: true},
		{Name: "evil", Value: "x", Domain: "other.com"},                // rejected: not this host
		{Name: "old", Value: "x", Expires: time.Now().Add(-time.Hour)}, // already expired
	})
	for _, c := range []struct{ url, want string }{
		{"https://api.example.com/auth/me", "host=1; sec=3; dom=2"},
		{"http://api.example.com/auth/me", "host=1; dom=2"}, // Secure needs https
		{"https://api.example.com/other", "sec=3; dom=2"},   // /auth path only
		{"https://www.example.com/", "dom=2"},               // host-only stays on api.
		{"https://example.com.evil.net/", ""},               // suffix trick
		{"https://api.example.com/authx", "sec=3; dom=2"},   // /auth doesn't match /authx
	} {
		if got := names(l.Cookies(u(c.url))); got != c.want {
			t.Errorf("%s: got %q want %q", c.url, got, c.want)
		}
	}
	// Max-Age=0 (MaxAge -1 in Go) deletes; ListCookies shows what's left.
	l.SetCookies(u("https://api.example.com/"), []*http.Cookie{{Name: "dom", Domain: "example.com", Path: "/", MaxAge: -1}})
	all, _ := l.ListCookies()
	if len(all) != 2 {
		t.Fatalf("after delete: %+v", all)
	}
	if err := l.DeleteCookies("api.example.com", "/auth", "host"); err != nil {
		t.Fatal(err)
	}
	if all, _ = l.ListCookies(); len(all) != 1 || all[0].Name != "sec" {
		t.Fatalf("after single delete: %+v", all)
	}
	l.DeleteCookies("", "", "")
	if all, _ = l.ListCookies(); len(all) != 0 {
		t.Fatalf("after clear: %+v", all)
	}
}
