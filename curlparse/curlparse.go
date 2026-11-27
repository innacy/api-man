package curlparse

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/shlex"
)

type Target struct {
	Method          string // "GET", "POST", ...
	URL             string
	Header          http.Header
	Body            []byte
	Insecure        bool // -k / --insecure
	FollowRedirects bool // -L / --location
}

// joinLineContinuations removes backslash-newline sequences outside of
// quotes, matching how a shell joins a multi-line curl command (the format
// browsers' "Copy as cURL" and tools like Postman produce) into one logical
// line before tokenizing. Backslash-newline inside a quoted string (e.g. a
// --data payload) is left untouched — it isn't a continuation there, it's
// literal data.
func joinLineContinuations(cmd string) string {
	var b strings.Builder
	var quote byte // 0, '\'', or '"'
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if quote == 0 && c == '\\' && i+1 < len(cmd) && (cmd[i+1] == '\n' || (cmd[i+1] == '\r' && i+2 < len(cmd) && cmd[i+2] == '\n')) {
			if cmd[i+1] == '\r' {
				i += 2
			} else {
				i++
			}
			continue
		}
		if quote == 0 && (c == '\'' || c == '"') {
			quote = c
		} else if quote != 0 && c == quote {
			quote = 0
		}
		b.WriteByte(c)
	}
	return b.String()
}

// Parse parses a pasted curl command line.
// Returns a descriptive error for unsupported flags — never silently ignores.
func Parse(cmd string) (Target, error) {
	toks, err := shlex.Split(strings.TrimSpace(joinLineContinuations(cmd)))
	if err != nil {
		return Target{}, fmt.Errorf("cannot parse command: %w", err)
	}
	if len(toks) > 0 && toks[0] == "curl" {
		toks = toks[1:]
	}
	t := Target{Header: http.Header{}}
	dataSeen, urlencoded := false, false
	next := func(i int, flag string) (string, error) {
		if i+1 >= len(toks) {
			return "", fmt.Errorf("flag %s expects a value", flag)
		}
		return toks[i+1], nil
	}
	for i := 0; i < len(toks); i++ {
		tok := toks[i]
		switch {
		case tok == "-X" || tok == "--request":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			t.Method = strings.ToUpper(v)
			i++
		case tok == "-H" || tok == "--header":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			k, val, ok := strings.Cut(v, ":")
			if !ok {
				return Target{}, fmt.Errorf("malformed header %q", v)
			}
			t.Header.Add(strings.TrimSpace(k), strings.TrimSpace(val))
			i++
		case tok == "-d" || tok == "--data" || tok == "--data-raw" || tok == "--data-binary":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			appendData(&t, v)
			dataSeen = true
			i++
		case tok == "--data-urlencode":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			// curl forms: "content", "=content", "name=content"; @file forms need disk access.
			name, content, hasEq := strings.Cut(v, "=")
			if !hasEq {
				name, content = "", v
			}
			if strings.HasPrefix(v, "@") || (!hasEq && strings.Contains(v, "@")) {
				return Target{}, fmt.Errorf("--data-urlencode with @file is not supported")
			}
			enc := url.QueryEscape(content)
			if name != "" {
				enc = name + "=" + enc
			}
			appendData(&t, enc)
			urlencoded = true
			dataSeen = true
			i++
		case tok == "-u" || tok == "--user":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			t.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(v)))
			i++
		case tok == "-k" || tok == "--insecure":
			t.Insecure = true
		case tok == "-L" || tok == "--location":
			t.FollowRedirects = true
		case tok == "--url":
			v, err := next(i, tok)
			if err != nil {
				return Target{}, err
			}
			t.URL = v
			i++
		case strings.HasPrefix(tok, "-"):
			return Target{}, fmt.Errorf("flag %s not supported yet", tok)
		default:
			if t.URL != "" {
				return Target{}, fmt.Errorf("unexpected argument %q", tok)
			}
			t.URL = tok
		}
	}
	if t.URL == "" {
		return Target{}, fmt.Errorf("no URL found in command")
	}
	if !strings.HasPrefix(t.URL, "http://") && !strings.HasPrefix(t.URL, "https://") {
		t.URL = "http://" + t.URL
	}
	if urlencoded && t.Header.Get("Content-Type") == "" {
		t.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if t.Method == "" {
		if dataSeen {
			t.Method = "POST"
		} else {
			t.Method = "GET"
		}
	}
	return t, nil
}

// appendData joins repeated data flags with '&', as curl does.
func appendData(t *Target, v string) {
	if len(t.Body) > 0 {
		t.Body = append(t.Body, '&')
	}
	t.Body = append(t.Body, v...)
}
