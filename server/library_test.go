package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// call sends method+path with an optional JSON body and decodes the JSON reply into out.
func call(t *testing.T, ts *httptest.Server, method, path, body string, out any) int {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func TestLibraryEndpoints(t *testing.T) {
	ts, _ := newTestServer(t)

	var col struct{ ID int64 }
	if code := call(t, ts, "POST", "/api/collections", `{"name":"  Users  "}`, &col); code != 201 || col.ID == 0 {
		t.Fatalf("create collection: %d %+v", code, col)
	}
	var req struct{ ID int64 }
	body := `{"collectionId":` + jsonInt(col.ID) + `,"name":"List","method":"GET","url":"http://h/u","data":{"url":"http://h/u"}}`
	if code := call(t, ts, "POST", "/api/requests", body, &req); code != 201 || req.ID == 0 {
		t.Fatalf("create request: %d", code)
	}
	if code := call(t, ts, "PUT", "/api/requests/"+jsonInt(req.ID), `{"collectionId":null,"name":"Renamed","method":"POST","url":"http://h/x","data":{"a":1}}`, nil); code != 200 {
		t.Fatalf("update request: %d", code)
	}
	var got struct {
		Name         string
		CollectionID *int64
		Data         map[string]int
	}
	if code := call(t, ts, "GET", "/api/requests/"+jsonInt(req.ID), "", &got); code != 200 || got.Name != "Renamed" || got.CollectionID != nil || got.Data["a"] != 1 {
		t.Fatalf("get request: %d %+v", code, got)
	}
	var tree struct {
		Collections []struct{ Name string }
		Requests    []struct{ Name string }
	}
	if call(t, ts, "GET", "/api/library", "", &tree); len(tree.Collections) != 1 || tree.Collections[0].Name != "Users" || len(tree.Requests) != 1 {
		t.Fatalf("tree = %+v", tree)
	}
	if code := call(t, ts, "PUT", "/api/collections/"+jsonInt(col.ID), `{"name":"Users v2"}`, nil); code != 200 {
		t.Fatalf("rename: %d", code)
	}
	if code := call(t, ts, "DELETE", "/api/collections/"+jsonInt(col.ID), "", nil); code != 200 {
		t.Fatalf("delete collection: %d", code)
	}
	if code := call(t, ts, "DELETE", "/api/requests/"+jsonInt(req.ID), "", nil); code != 200 {
		t.Fatalf("delete request: %d", code)
	}

	for name, c := range map[string]struct {
		method, path, body string
		want               int
	}{
		"missing request":    {"GET", "/api/requests/999", "", 404},
		"bad id":             {"GET", "/api/requests/abc", "", 400},
		"empty name":         {"POST", "/api/requests", `{"name":" ","method":"GET","url":"u","data":{}}`, 400},
		"data not an object": {"POST", "/api/requests", `{"name":"n","method":"GET","url":"u","data":[1]}`, 400},
		"unknown collection": {"POST", "/api/requests", `{"collectionId":77,"name":"n","method":"GET","url":"u","data":{}}`, 400},
		"empty collection":   {"POST", "/api/collections", `{"name":""}`, 400},
		"rename missing":     {"PUT", "/api/collections/999", `{"name":"x"}`, 404},
		"update missing":     {"PUT", "/api/requests/999", `{"name":"n","method":"GET","url":"u","data":{}}`, 404},
	} {
		if code := call(t, ts, c.method, c.path, c.body, nil); code != c.want {
			t.Errorf("%s: status %d, want %d", name, code, c.want)
		}
	}
}

func TestSendRecordsHistory(t *testing.T) {
	ts, _ := newTestServer(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer target.Close()

	call(t, ts, "POST", "/api/send", `{"method":"DELETE","url":"`+target.URL+`/x","headers":[["A","1"]],"body":"b"}`, nil)
	call(t, ts, "POST", "/api/send", `{"method":"GET","url":"http://127.0.0.1:1/"}`, nil)

	type entry struct {
		ID                 int64
		Method, URL, Error string
		Status             int
		Data               *struct {
			Headers [][2]string
			Body    string
		}
	}
	var h []entry
	call(t, ts, "GET", "/api/history", "", &h)
	if len(h) != 2 || h[0].Error == "" || h[1].Method != "DELETE" || h[1].Status != 204 || h[1].URL != target.URL+"/x" || h[1].Data != nil {
		t.Fatalf("history = %+v", h)
	}
	var one entry
	if code := call(t, ts, "GET", "/api/history/"+jsonInt(h[1].ID), "", &one); code != 200 || one.Data == nil ||
		one.Data.Body != "b" || len(one.Data.Headers) != 1 {
		t.Fatalf("history entry: %d %+v", code, one)
	}
	if code := call(t, ts, "GET", "/api/history/999", "", nil); code != 404 {
		t.Fatalf("missing history entry: %d", code)
	}
	if code := call(t, ts, "DELETE", "/api/history", "", nil); code != 200 {
		t.Fatalf("clear: %d", code)
	}
	if call(t, ts, "GET", "/api/history", "", &h); len(h) != 0 {
		t.Fatalf("after clear: %d", len(h))
	}
}

func TestEnvironmentsAndImport(t *testing.T) {
	ts, _ := newTestServer(t)
	var env struct{ ID int64 }
	if code := call(t, ts, "POST", "/api/environments", `{"name":"Local","vars":[{"on":true,"k":"host","v":"h"}]}`, &env); code != 201 || env.ID == 0 {
		t.Fatalf("create env: %d", code)
	}
	if code := call(t, ts, "PUT", "/api/environments/"+jsonInt(env.ID), `{"name":"Local 2","vars":[]}`, nil); code != 200 {
		t.Fatalf("update env: %d", code)
	}
	var envs []struct{ Name string }
	if call(t, ts, "GET", "/api/environments", "", &envs); len(envs) != 1 || envs[0].Name != "Local 2" {
		t.Fatalf("envs = %+v", envs)
	}
	if code := call(t, ts, "POST", "/api/environments", `{"name":"x","vars":{}}`, nil); code != 400 {
		t.Fatalf("vars not a list: %d", code)
	}
	if code := call(t, ts, "DELETE", "/api/environments/"+jsonInt(env.ID), "", nil); code != 200 {
		t.Fatalf("delete env: %d", code)
	}

	var imp struct{ CollectionID, EnvironmentID int64 }
	body := `{"name":"Shop","requests":[{"name":"List","method":"GET","url":"{{host}}/items","data":{"url":"{{host}}/items"}}],
	          "environment":{"name":"Shop vars","vars":[{"on":true,"k":"host","v":"http://h"}]}}`
	if code := call(t, ts, "POST", "/api/import", body, &imp); code != 201 || imp.CollectionID == 0 || imp.EnvironmentID == 0 {
		t.Fatalf("import: %d %+v", code, imp)
	}
	var tree struct{ Requests []struct{ Name string } }
	if call(t, ts, "GET", "/api/library", "", &tree); len(tree.Requests) != 1 {
		t.Fatalf("tree after import = %+v", tree)
	}
	if code := call(t, ts, "POST", "/api/import", `{"name":"x","requests":[{"name":"r","method":"GET","url":"u","data":[1]}]}`, nil); code != 400 {
		t.Fatalf("bad request data: %d", code)
	}
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestFoldersAndPatch(t *testing.T) {
	ts, _ := newTestServer(t)
	var col, fol, sub, req struct{ ID int64 }
	call(t, ts, "POST", "/api/collections", `{"name":"C"}`, &col)
	if code := call(t, ts, "POST", "/api/folders", `{"collectionId":`+jsonInt(col.ID)+`,"name":"Users"}`, &fol); code != 201 {
		t.Fatalf("create folder: %d", code)
	}
	if code := call(t, ts, "POST", "/api/folders", `{"parentId":`+jsonInt(fol.ID)+`,"name":"Admin"}`, &sub); code != 201 {
		t.Fatalf("create sub-folder: %d", code)
	}
	if code := call(t, ts, "POST", "/api/folders", `{"collectionId":999,"name":"x"}`, nil); code != 400 {
		t.Fatalf("folder in unknown collection: %d", code)
	}
	call(t, ts, "POST", "/api/requests", `{"folderId":`+jsonInt(sub.ID)+`,"name":"r","method":"GET","url":"u","data":{}}`, &req)
	if code := call(t, ts, "PATCH", "/api/requests/"+jsonInt(req.ID), `{"name":"renamed","move":{"collectionId":`+jsonInt(col.ID)+`,"folderId":null}}`, nil); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	if code := call(t, ts, "PATCH", "/api/requests/"+jsonInt(req.ID), `{"move":{"folderId":999}}`, nil); code != 400 {
		t.Fatalf("move to unknown folder: %d", code)
	}
	if code := call(t, ts, "PATCH", "/api/requests/999", `{"name":"x"}`, nil); code != 404 {
		t.Fatalf("patch unknown: %d", code)
	}
	var tree struct {
		Folders []struct {
			Name     string
			ParentID *int64
		}
		Requests []struct {
			Name     string
			FolderID *int64
		}
	}
	call(t, ts, "GET", "/api/library", "", &tree)
	if len(tree.Folders) != 2 || len(tree.Requests) != 1 || tree.Requests[0].Name != "renamed" || tree.Requests[0].FolderID != nil {
		t.Fatalf("tree = %+v", tree)
	}
	if code := call(t, ts, "PATCH", "/api/folders/"+jsonInt(fol.ID), `{"move":{"collectionId":`+jsonInt(col.ID)+`,"parentId":`+jsonInt(sub.ID)+`}}`, nil); code != 400 {
		t.Fatalf("move folder into its child: %d", code)
	}
	if code := call(t, ts, "PATCH", "/api/folders/"+jsonInt(sub.ID), `{"move":{"collectionId":`+jsonInt(col.ID)+`}}`, nil); code != 200 {
		t.Fatalf("move folder to root: %d", code)
	}
	if code := call(t, ts, "PUT", "/api/folders/"+jsonInt(fol.ID), `{"name":"People"}`, nil); code != 200 {
		t.Fatalf("rename folder: %d", code)
	}
	if code := call(t, ts, "DELETE", "/api/folders/"+jsonInt(fol.ID), "", nil); code != 200 {
		t.Fatalf("delete folder: %d", code)
	}
	call(t, ts, "GET", "/api/library", "", &tree)
	if len(tree.Folders) != 1 {
		t.Fatalf("want only the moved-out folder left: %+v", tree.Folders)
	}
}
