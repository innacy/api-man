package store

import (
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Cookie is one stored cookie as the Cookies dialog shows it. Expires is
// unix seconds; 0 means a session cookie, kept until cleared (as Postman does).
type Cookie struct {
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	Expires  int64  `json:"expires"`
	Secure   bool   `json:"secure"`
	HTTPOnly bool   `json:"httpOnly"`
	HostOnly bool   `json:"hostOnly"`
}

const cookieSchema = `
CREATE TABLE IF NOT EXISTS cookies(
  domain TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
  value TEXT NOT NULL, expires INTEGER NOT NULL,
  secure INTEGER NOT NULL, http_only INTEGER NOT NULL, host_only INTEGER NOT NULL,
  PRIMARY KEY(domain, path, name)
);`

// SetCookies stores the Set-Cookie values of a response from u, making
// Library an http.CookieJar for the Send tab. Cookies for other domains, and
// Max-Age=0 / past-Expires deletions, follow RFC 6265.
// ponytail: no public-suffix list, so a server could set Domain=com for
// itself; harmless for a single-user local client, add x/net/publicsuffix if not.
func (l *Library) SetCookies(u *url.URL, cookies []*http.Cookie) {
	host := strings.ToLower(u.Hostname())
	for _, c := range cookies {
		domain, hostOnly := strings.TrimPrefix(strings.ToLower(c.Domain), "."), false
		if domain == "" {
			domain, hostOnly = host, true
		} else if host != domain && !strings.HasSuffix(host, "."+domain) {
			continue // a server may only set cookies for itself or a parent domain
		}
		path := c.Path
		if !strings.HasPrefix(path, "/") {
			path = defaultPath(u.Path)
		}
		var exp int64
		switch {
		case c.MaxAge < 0:
			exp = -1
		case c.MaxAge > 0:
			exp = time.Now().Unix() + int64(c.MaxAge)
		case !c.Expires.IsZero():
			if exp = c.Expires.Unix(); exp <= time.Now().Unix() {
				exp = -1
			}
		}
		var err error
		if exp < 0 {
			_, err = l.db.Exec(`DELETE FROM cookies WHERE domain=? AND path=? AND name=?`, domain, path, c.Name)
		} else {
			_, err = l.db.Exec(`INSERT OR REPLACE INTO cookies VALUES(?,?,?,?,?,?,?,?)`,
				domain, path, c.Name, c.Value, exp, c.Secure, c.HttpOnly, hostOnly)
		}
		if err != nil {
			log.Printf("cookies: %v", err)
		}
	}
}

// Cookies returns the cookies to send to u, longest path first.
func (l *Library) Cookies(u *url.URL) []*http.Cookie {
	all, err := l.ListCookies()
	if err != nil {
		log.Printf("cookies: %v", err)
		return nil
	}
	host, p := strings.ToLower(u.Hostname()), u.Path
	if p == "" {
		p = "/"
	}
	var match []Cookie
	for _, c := range all {
		domainOK := host == c.Domain || (!c.HostOnly && strings.HasSuffix(host, "."+c.Domain))
		pathOK := p == c.Path || (strings.HasPrefix(p, c.Path) && (strings.HasSuffix(c.Path, "/") || p[len(c.Path)] == '/'))
		if domainOK && pathOK && (!c.Secure || u.Scheme == "https") {
			match = append(match, c)
		}
	}
	sort.SliceStable(match, func(i, j int) bool { return len(match[i].Path) > len(match[j].Path) })
	out := make([]*http.Cookie, len(match))
	for i, c := range match {
		out[i] = &http.Cookie{Name: c.Name, Value: c.Value}
	}
	return out
}

// ListCookies returns every unexpired cookie, dropping expired ones.
func (l *Library) ListCookies() ([]Cookie, error) {
	if _, err := l.db.Exec(`DELETE FROM cookies WHERE expires > 0 AND expires <= ?`, time.Now().Unix()); err != nil {
		return nil, err
	}
	out := []Cookie{}
	err := l.each(`SELECT domain, path, name, value, expires, secure, http_only, host_only FROM cookies ORDER BY domain, path, name`,
		func(scan func(...any) error) error {
			var c Cookie
			if err := scan(&c.Domain, &c.Path, &c.Name, &c.Value, &c.Expires, &c.Secure, &c.HTTPOnly, &c.HostOnly); err != nil {
				return err
			}
			out = append(out, c)
			return nil
		})
	return out, err
}

// DeleteCookies removes cookies: all of them when domain is "", else that
// domain's, else (with name) one cookie.
func (l *Library) DeleteCookies(domain, path, name string) error {
	var err error
	switch {
	case domain == "":
		_, err = l.db.Exec(`DELETE FROM cookies`)
	case name == "":
		_, err = l.db.Exec(`DELETE FROM cookies WHERE domain=?`, domain)
	default:
		_, err = l.db.Exec(`DELETE FROM cookies WHERE domain=? AND path=? AND name=?`, domain, path, name)
	}
	return err
}

// defaultPath is RFC 6265's default cookie path: the request path up to its last "/".
func defaultPath(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "/"
}
