package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func openLib(t *testing.T) (*Library, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sub", "requests.db")
	l, err := OpenLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l, path
}

func TestLibraryFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no Unix permission bits; Go reports 0666/0777")
	}
	_, path := openLib(t)
	for p, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != want {
			t.Errorf("%s perm = %o, want %o", p, st.Mode().Perm(), want)
		}
	}
}

func TestLibraryRequestsAndCollections(t *testing.T) {
	l, _ := openLib(t)
	cid, err := l.CreateCollection("Users API")
	if err != nil {
		t.Fatal(err)
	}
	data := json.RawMessage(`{"method":"GET","url":"http://h/u","headers":[]}`)
	rid, err := l.SaveRequest(SavedRequest{CollectionID: &cid, Name: "List users", Method: "GET", URL: "http://h/u", Data: data})
	if err != nil {
		t.Fatal(err)
	}
	loose, err := l.SaveRequest(SavedRequest{Name: "Loose", Method: "POST", URL: "http://h/p", Data: data})
	if err != nil {
		t.Fatal(err)
	}

	got, err := l.GetRequest(rid)
	if err != nil || got.Name != "List users" || *got.CollectionID != cid || string(got.Data) != string(data) || got.UpdatedAt == "" {
		t.Fatalf("get = %+v, %v", got, err)
	}

	// Update in place: rename and move out of the collection.
	got.Name, got.CollectionID = "All users", nil
	if _, err := l.SaveRequest(got); err != nil {
		t.Fatal(err)
	}
	if again, _ := l.GetRequest(rid); again.Name != "All users" || again.CollectionID != nil {
		t.Fatalf("after update = %+v", again)
	}
	if _, err := l.SaveRequest(SavedRequest{ID: 999, Name: "x", Method: "GET", URL: "u", Data: data}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("update missing id: err = %v, want ErrNoRows", err)
	}
	bad := int64(424242)
	if _, err := l.SaveRequest(SavedRequest{CollectionID: &bad, Name: "x", Method: "GET", URL: "u", Data: data}); !errors.Is(err, ErrUnknownCollection) {
		t.Fatalf("unknown collection: err = %v", err)
	}

	if err := l.RenameCollection(cid, "Users v2"); err != nil {
		t.Fatal(err)
	}
	cols, _, reqs, err := l.Tree()
	if err != nil || len(cols) != 1 || cols[0].Name != "Users v2" || len(reqs) != 2 || reqs[0].Data != nil {
		t.Fatalf("tree = %+v %+v %v", cols, reqs, err)
	}

	// Deleting a collection deletes the requests inside it only.
	moved, _ := l.GetRequest(loose)
	moved.CollectionID = &cid
	l.SaveRequest(moved)
	if err := l.DeleteCollection(cid); err != nil {
		t.Fatal(err)
	}
	if _, err := l.GetRequest(loose); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("request in deleted collection: err = %v", err)
	}
	if _, err := l.GetRequest(rid); err != nil {
		t.Fatalf("request outside collection was deleted: %v", err)
	}
	if err := l.DeleteRequest(rid); err != nil {
		t.Fatal(err)
	}
	if err := l.DeleteRequest(rid); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("double delete: err = %v", err)
	}
	if err := l.DeleteCollection(cid); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("delete missing collection: err = %v", err)
	}
}

func TestLibraryEnvironments(t *testing.T) {
	l, _ := openLib(t)
	vars := json.RawMessage(`[{"on":true,"k":"host","v":"http://localhost:8080"}]`)
	id, err := l.SaveEnvironment(Environment{Name: "Local", Vars: vars})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.SaveEnvironment(Environment{ID: id, Name: "Local dev", Vars: vars}); err != nil {
		t.Fatal(err)
	}
	envs, err := l.Environments()
	if err != nil || len(envs) != 1 || envs[0].Name != "Local dev" || string(envs[0].Vars) != string(vars) {
		t.Fatalf("envs = %+v, %v", envs, err)
	}
	if _, err := l.SaveEnvironment(Environment{ID: 99, Name: "x", Vars: vars}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("update missing env: %v", err)
	}
	if err := l.DeleteEnvironment(id); err != nil {
		t.Fatal(err)
	}
	if err := l.DeleteEnvironment(id); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("double delete env: %v", err)
	}
}

func TestLibraryImportIsAllOrNothing(t *testing.T) {
	l, _ := openLib(t)
	data := json.RawMessage(`{}`)
	cid, err := l.ImportCollection("Shop", []ImportRequest{
		{SavedRequest: SavedRequest{Name: "List", Method: "GET", URL: "u1", Data: data}, Folder: []string{"Items"}},
		{SavedRequest: SavedRequest{Name: "Create", Method: "POST", URL: "u2", Data: data}, Folder: []string{"Items", "Admin"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cols, folders, reqs, _ := l.Tree()
	if len(cols) != 1 || cols[0].ID != cid || len(reqs) != 2 || *reqs[0].CollectionID != cid {
		t.Fatalf("after import: %+v %+v", cols, reqs)
	}
	// Folders: "Admin" inside "Items", shared by both requests' paths.
	if len(folders) != 2 || folders[0].Name != "Admin" || *folders[0].ParentID != folders[1].ID || folders[1].ParentID != nil {
		t.Fatalf("folders = %+v", folders)
	}
	// One bad request (no data) rolls back the collection and the good request.
	if _, err := l.ImportCollection("Broken", []ImportRequest{{SavedRequest: SavedRequest{Name: "ok", Method: "GET", URL: "u", Data: data}, Folder: []string{"F"}}, {SavedRequest: SavedRequest{Name: "bad", Method: "GET", URL: "u"}}}); err == nil {
		t.Fatal("want error for request without data")
	}
	if cols, folders, reqs, _ := l.Tree(); len(cols) != 1 || len(folders) != 2 || len(reqs) != 2 {
		t.Fatalf("failed import left rows behind: %d collections, %d requests", len(cols), len(reqs))
	}
}

func TestLibraryFolders(t *testing.T) {
	l, _ := openLib(t)
	data := json.RawMessage(`{}`)
	c1, _ := l.CreateCollection("A")
	c2, _ := l.CreateCollection("B")
	f1, err := l.CreateFolder(c1, nil, "Users")
	if err != nil {
		t.Fatal(err)
	}
	// A sub-folder takes its parent's collection, whatever the caller says.
	f2, err := l.CreateFolder(c2, &f1, "Admin")
	if err != nil {
		t.Fatal(err)
	}
	// Saving into a folder puts the request in that folder's collection.
	id, err := l.SaveRequest(SavedRequest{CollectionID: &c2, FolderID: &f2, Name: "r", Method: "GET", URL: "u", Data: data})
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := l.GetRequest(id); *r.CollectionID != c1 || *r.FolderID != f2 {
		t.Fatalf("placement = %v %v", *r.CollectionID, *r.FolderID)
	}
	bad := int64(999)
	if _, err := l.SaveRequest(SavedRequest{FolderID: &bad, Name: "r", Method: "GET", URL: "u", Data: data}); !errors.Is(err, ErrUnknownFolder) {
		t.Fatalf("unknown folder: %v", err)
	}
	// Move to another collection's root, then rename.
	if err := l.MoveRequest(id, &c2, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.RenameRequest(id, "renamed"); err != nil {
		t.Fatal(err)
	}
	if r, _ := l.GetRequest(id); *r.CollectionID != c2 || r.FolderID != nil || r.Name != "renamed" {
		t.Fatalf("after move: %+v", r)
	}
	if err := l.MoveRequest(id, &bad, nil); !errors.Is(err, ErrUnknownCollection) {
		t.Fatalf("move to unknown collection: %v", err)
	}
	if err := l.MoveRequest(bad, &c2, nil); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("move unknown request: %v", err)
	}
	// Deleting a folder deletes its sub-folders and their requests.
	if err := l.MoveRequest(id, nil, &f2); err != nil {
		t.Fatal(err)
	}
	if err := l.DeleteFolder(f1); err != nil {
		t.Fatal(err)
	}
	if _, folders, reqs, _ := l.Tree(); len(folders) != 0 || len(reqs) != 0 {
		t.Fatalf("after folder delete: %+v %+v", folders, reqs)
	}
}

func TestLibraryMoveFolder(t *testing.T) {
	l, _ := openLib(t)
	c1, _ := l.CreateCollection("A")
	c2, _ := l.CreateCollection("B")
	f1, _ := l.CreateFolder(c1, nil, "top")
	f2, _ := l.CreateFolder(c1, &f1, "sub")
	id, _ := l.SaveRequest(SavedRequest{FolderID: &f2, Name: "r", Method: "GET", URL: "u", Data: json.RawMessage(`{}`)})
	if err := l.MoveFolder(f1, c1, &f2); !errors.Is(err, ErrFolderCycle) {
		t.Fatalf("into own child: %v", err)
	}
	if err := l.MoveFolder(f1, c1, &f1); !errors.Is(err, ErrFolderCycle) {
		t.Fatalf("into itself: %v", err)
	}
	// Moving "top" to collection B carries "sub" and its request along.
	if err := l.MoveFolder(f1, c2, nil); err != nil {
		t.Fatal(err)
	}
	_, folders, _, _ := l.Tree()
	for _, f := range folders {
		if f.CollectionID != c2 {
			t.Fatalf("folder %s left in collection %d", f.Name, f.CollectionID)
		}
	}
	if r, _ := l.GetRequest(id); *r.CollectionID != c2 {
		t.Fatalf("request collection = %d", *r.CollectionID)
	}
	// Into another folder: takes that folder's collection.
	f3, _ := l.CreateFolder(c1, nil, "other")
	if err := l.MoveFolder(f2, c2, &f3); err != nil {
		t.Fatal(err)
	}
	if r, _ := l.GetRequest(id); *r.CollectionID != c1 {
		t.Fatalf("after move into folder: collection = %d", *r.CollectionID)
	}
	bad := int64(999)
	if err := l.MoveFolder(bad, c1, nil); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unknown folder: %v", err)
	}
	if err := l.MoveFolder(f2, c1, &bad); !errors.Is(err, ErrUnknownFolder) {
		t.Fatalf("unknown parent: %v", err)
	}
	if err := l.MoveFolder(f2, bad, nil); !errors.Is(err, ErrUnknownCollection) {
		t.Fatalf("unknown collection: %v", err)
	}
}

// A library from before folders existed gains requests.folder_id on open.
func TestLibraryMigratesFolderColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE collections(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE requests(id INTEGER PRIMARY KEY, collection_id INTEGER, name TEXT NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO requests(name, method, url, data, updated_at) VALUES('old', 'GET', 'u', '{}', 'x')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	l, err := OpenLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, _, reqs, err := l.Tree(); err != nil || len(reqs) != 1 || reqs[0].FolderID != nil {
		t.Fatalf("migrated tree = %+v %v", reqs, err)
	}
}

func TestLibraryHistoryKeepsNewest(t *testing.T) {
	l, _ := openLib(t)
	old := historyLimit
	historyLimit = 3
	defer func() { historyLimit = old }()
	for i := 1; i <= 5; i++ {
		err := l.AddHistory(HistoryEntry{Method: "GET", URL: "http://h/" + string(rune('0'+i)), Status: 200, TimeMs: 1.5, Size: int64(i), Data: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
	}
	h, err := l.History()
	if err != nil {
		t.Fatal(err)
	}
	if len(h) != 3 || h[0].URL != "http://h/5" || h[2].URL != "http://h/3" || h[0].At == "" || h[0].Data != nil {
		t.Fatalf("history = %+v", h)
	}
	one, err := l.GetHistory(h[0].ID)
	if err != nil || string(one.Data) != `{}` || one.Size != 5 {
		t.Fatalf("get history = %+v, %v", one, err)
	}
	if _, err := l.GetHistory(999); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing history: err = %v", err)
	}
	if err := l.ClearHistory(); err != nil {
		t.Fatal(err)
	}
	if h, _ := l.History(); len(h) != 0 {
		t.Fatalf("after clear: %d entries", len(h))
	}
}
