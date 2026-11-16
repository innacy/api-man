package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postJSON(t *testing.T, url, body string, mod func(*http.Request)) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if mod != nil {
		mod(req)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSendEndpoint(t *testing.T) {
	ts, _ := newTestServer(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Seen", r.Method+" "+r.Header.Get("A")+","+r.Header.Get("B"))
		w.WriteHeader(418)
		w.Write([]byte("teapot"))
	}))
	defer target.Close()

	res := postJSON(t, ts.URL+"/api/send",
		`{"method":"put","url":"`+target.URL+`","headers":[["A","1"],["B","2"]],"body":"x"}`, nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var got struct {
		Status int
		Body   string
		Header http.Header
	}
	json.NewDecoder(res.Body).Decode(&got)
	body, _ := base64.StdEncoding.DecodeString(got.Body)
	if got.Status != 418 || string(body) != "teapot" || got.Header.Get("X-Seen") != "PUT 1,2" {
		t.Fatalf("got status=%d body=%q seen=%q", got.Status, body, got.Header.Get("X-Seen"))
	}
}

func TestParseCurlEndpoint(t *testing.T) {
	ts, _ := newTestServer(t)
	res := postJSON(t, ts.URL+"/api/curl", `{"curl":"curl -k -L -H 'A: 1' -d '{\"x\":1}' http://h/p"}`, nil)
	defer res.Body.Close()
	var got sendRequest
	json.NewDecoder(res.Body).Decode(&got)
	if res.StatusCode != 200 || got.Method != "POST" || got.URL != "http://h/p" || got.Body != `{"x":1}` ||
		!got.Insecure || !got.FollowRedirects || len(got.Headers) != 1 || got.Headers[0] != [2]string{"A", "1"} {
		t.Fatalf("status=%d got=%+v", res.StatusCode, got)
	}
	res = postJSON(t, ts.URL+"/api/curl", `{"curl":"curl --nope http://h"}`, nil)
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("unsupported flag: status = %d, want 400", res.StatusCode)
	}
}

func TestSendValidation(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, body := range []string{
		`{"method":"GET","url":"ftp://x/y"}`,
		`{"method":"GET","url":"http://"}`,
		`{"method":"G ET","url":"http://localhost/"}`,
		`{"method":"GET","url":"http://localhost/","timeoutMs":999999999}`,
		`not json`,
	} {
		res := postJSON(t, ts.URL+"/api/send", body, nil)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Errorf("%s: status = %d, want 400", body, res.StatusCode)
		}
	}
}

func TestRejectsNonLocalOriginAndHost(t *testing.T) {
	ts, _ := newTestServer(t)
	cases := map[string]func(*http.Request){
		"foreign origin":   func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
		"other local port": func(r *http.Request) { r.Header.Set("Origin", "http://localhost:1") },
		"null origin":      func(r *http.Request) { r.Header.Set("Origin", "null") },
		"rebound host":     func(r *http.Request) { r.Host = "evil.example" },
	}
	for name, mod := range cases {
		res := postJSON(t, ts.URL+"/api/send", `{"method":"GET","url":"http://localhost/"}`, mod)
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s: status = %d, want 403", name, res.StatusCode)
		}
	}
	// Same-origin requests from the UI still work.
	res := postJSON(t, ts.URL+"/api/send", `{"method":"GET","url":"http://127.0.0.1:1/"}`,
		func(r *http.Request) { r.Header.Set("Origin", ts.URL) })
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("same origin: status = %d, want 200", res.StatusCode)
	}
}

// Login sets a cookie; the next request to the same host sends it back,
// unless that request opts out with noCookies.
func TestSendCookieJar(t *testing.T) {
	ts, _ := newTestServer(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/"})
		}
		w.Write([]byte(r.Header.Get("Cookie")))
	}))
	defer target.Close()
	send := func(path string, extra string) string {
		res := postJSON(t, ts.URL+"/api/send", `{"method":"GET","url":"`+target.URL+path+`"`+extra+`}`, nil)
		defer res.Body.Close()
		var got struct{ Body string }
		json.NewDecoder(res.Body).Decode(&got)
		b, _ := base64.StdEncoding.DecodeString(got.Body)
		return string(b)
	}
	send("/login", "")
	if got := send("/me", ""); got != "sid=abc" {
		t.Fatalf("cookie not sent back: %q", got)
	}
	if got := send("/me", `,"noCookies":true`); got != "" {
		t.Fatalf("noCookies still sent: %q", got)
	}
	res, _ := http.Get(ts.URL + "/api/cookies")
	var list []struct{ Name, Domain string }
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list) != 1 || list[0].Name != "sid" || list[0].Domain != "127.0.0.1" {
		t.Fatalf("list = %+v", list)
	}
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/cookies", nil)
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if got := send("/me", ""); got != "" {
		t.Fatalf("cleared jar still sent: %q", got)
	}
}
