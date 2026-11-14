package engine

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"apiperf/curlparse"
)

func TestSendReturnsFullResponseAndSendsOnce(t *testing.T) {
	var hits atomic.Int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Got", r.Method+" "+r.Header.Get("X-Token"))
		w.WriteHeader(201)
		w.Write(append([]byte(`{"echo":`), append(b, '}')...))
	}))
	defer ts.Close()

	h := http.Header{}
	h.Set("X-Token", "abc")
	r := Send(curlparse.Target{Method: "POST", URL: ts.URL, Header: h, Body: []byte(`"hi"`)}, 2*time.Second)
	if r.Error != "" || r.Status != 201 || r.StatusText != "Created" {
		t.Fatalf("send = %+v", r)
	}
	if string(r.Body) != `{"echo":"hi"}` || r.Size != int64(len(r.Body)) || r.Truncated {
		t.Fatalf("body = %q size=%d truncated=%v", r.Body, r.Size, r.Truncated)
	}
	if r.Header.Get("X-Got") != "POST abc" || r.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("header = %v", r.Header)
	}
	if r.Phases.Remote == "" || r.TimeMs <= 0 {
		t.Fatalf("missing remote/time: %+v", r)
	}
	if hits.Load() != 1 {
		t.Fatalf("server hits = %d, want 1 (a POST must not be repeated)", hits.Load())
	}
}

func TestSendTruncatesLargeBody(t *testing.T) {
	old := maxSendBody
	maxSendBody = 10
	defer func() { maxSendBody = old }()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(strings.Repeat("x", 25)))
	}))
	defer ts.Close()

	r := Send(curlparse.Target{Method: "GET", URL: ts.URL, Header: http.Header{}}, 2*time.Second)
	if len(r.Body) != 10 || !r.Truncated || r.Size != 25 {
		t.Fatalf("len=%d truncated=%v size=%d, want 10/true/25", len(r.Body), r.Truncated, r.Size)
	}
}

func TestSendRedirects(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("final"))
	}))
	defer final.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL+"/end", http.StatusFound)
	}))
	defer redir.Close()

	r := Send(curlparse.Target{Method: "GET", URL: redir.URL, Header: http.Header{}}, 2*time.Second)
	if r.Status != 302 || len(r.Redirects) != 0 {
		t.Fatalf("no-follow: status=%d redirects=%v", r.Status, r.Redirects)
	}
	r = Send(curlparse.Target{Method: "GET", URL: redir.URL, Header: http.Header{}, FollowRedirects: true}, 2*time.Second)
	if r.Status != 200 || string(r.Body) != "final" || len(r.Redirects) != 1 || r.Redirects[0] != final.URL+"/end" {
		t.Fatalf("follow: status=%d body=%q redirects=%v", r.Status, r.Body, r.Redirects)
	}
}

func TestSendConnectionError(t *testing.T) {
	r := Send(curlparse.Target{Method: "GET", URL: "http://127.0.0.1:1", Header: http.Header{}}, time.Second)
	if r.Error == "" || r.Status != 0 {
		t.Fatalf("want connection error, got %+v", r)
	}
}
