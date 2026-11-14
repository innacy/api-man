package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Library holds the Send tab's collections, saved requests and history. It is
// a separate database from the load-test results so it doesn't depend on the
// directory apiperf was started from and never waits behind a run's writes.
type Library struct {
	db *sql.DB
}

// ErrUnknownCollection is returned when a request names a collection that doesn't exist.
var ErrUnknownCollection = errors.New("unknown collection")

// ErrFolderCycle is returned when a folder would be moved inside itself.
var ErrFolderCycle = errors.New("a folder can't be moved inside itself")

// ErrUnknownFolder is returned when a request or folder names a folder that doesn't exist.
var ErrUnknownFolder = errors.New("unknown folder")

// historyLimit is how many sent requests History keeps (var for tests).
var historyLimit = 500

const libSchema = `
CREATE TABLE IF NOT EXISTS collections(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS environments(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vars TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  time_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  error TEXT NOT NULL,
  data TEXT NOT NULL
);
`

// OpenLibrary opens (creating if needed) the library at path. Saved requests
// can hold tokens, so the directory is 0700 and the file 0600.
func OpenLibrary(path string) (*Library, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	// Pragmas in the DSN apply to every connection, including reopened ones.
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(libSchema); err != nil {
		db.Close()
		return nil, err
	}
	// Libraries created before folders existed lack requests.folder_id.
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('requests') WHERE name='folder_id'`).Scan(&n); err != nil {
		db.Close()
		return nil, err
	}
	if n == 0 {
		if _, err := db.Exec(`ALTER TABLE requests ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE`); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &Library{db: db}, nil
}

// Close closes the underlying database.
func (l *Library) Close() error { return l.db.Close() }

// Collection is a named group of saved requests.
type Collection struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Folder groups requests inside a collection; folders can nest (ParentID).
type Folder struct {
	ID           int64  `json:"id"`
	CollectionID int64  `json:"collectionId"`
	ParentID     *int64 `json:"parentId"`
	Name         string `json:"name"`
}

// SavedRequest is one saved request. Data is the Send tab's form state,
// stored as-is; Method and URL are copied out for listing and search.
type SavedRequest struct {
	ID           int64           `json:"id"`
	CollectionID *int64          `json:"collectionId"` // nil = not in a collection
	FolderID     *int64          `json:"folderId"`     // nil = directly in the collection
	Name         string          `json:"name"`
	Method       string          `json:"method"`
	URL          string          `json:"url"`
	Data         json.RawMessage `json:"data,omitempty"`
	UpdatedAt    string          `json:"updatedAt"`
}

// HistoryEntry is one request sent from the Send tab. Data is what was sent.
type HistoryEntry struct {
	ID     int64           `json:"id"`
	At     string          `json:"at"`
	Method string          `json:"method"`
	URL    string          `json:"url"`
	Status int             `json:"status"`
	TimeMs float64         `json:"timeMs"`
	Size   int64           `json:"size"`
	Error  string          `json:"error,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// affected turns "0 rows changed" into sql.ErrNoRows.
func affected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// CreateCollection adds a collection and returns its id.
func (l *Library) CreateCollection(name string) (int64, error) {
	res, err := l.db.Exec(`INSERT INTO collections(name) VALUES(?)`, name)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// RenameCollection renames a collection; sql.ErrNoRows if it doesn't exist.
func (l *Library) RenameCollection(id int64, name string) error {
	return affected(l.db.Exec(`UPDATE collections SET name=? WHERE id=?`, name, id))
}

// DeleteCollection deletes a collection and every request in it.
func (l *Library) DeleteCollection(id int64) error {
	return affected(l.db.Exec(`DELETE FROM collections WHERE id=?`, id))
}

// placement checks a (collection, folder) target. A folder decides the
// collection, so a request can never sit in another collection's folder.
func (l *Library) placement(collectionID, folderID *int64) (*int64, error) {
	if folderID == nil {
		return collectionID, nil
	}
	var cid int64
	if err := l.db.QueryRow(`SELECT collection_id FROM folders WHERE id=?`, *folderID).Scan(&cid); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUnknownFolder
		}
		return nil, err
	}
	return &cid, nil
}

// SaveRequest inserts r when r.ID is 0, otherwise updates it (sql.ErrNoRows
// if it doesn't exist). Returns the request's id.
func (l *Library) SaveRequest(r SavedRequest) (int64, error) {
	var res sql.Result
	var err error
	if r.CollectionID, err = l.placement(r.CollectionID, r.FolderID); err != nil {
		return 0, err
	}
	if r.ID == 0 {
		res, err = l.db.Exec(`INSERT INTO requests(collection_id, folder_id, name, method, url, data, updated_at) VALUES(?,?,?,?,?,?,?)`,
			r.CollectionID, r.FolderID, r.Name, r.Method, r.URL, string(r.Data), now())
	} else {
		res, err = l.db.Exec(`UPDATE requests SET collection_id=?, folder_id=?, name=?, method=?, url=?, data=?, updated_at=? WHERE id=?`,
			r.CollectionID, r.FolderID, r.Name, r.Method, r.URL, string(r.Data), now(), r.ID)
	}
	if err != nil && strings.Contains(err.Error(), "FOREIGN KEY") {
		return 0, ErrUnknownCollection
	}
	if r.ID != 0 {
		return r.ID, affected(res, err)
	}
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetRequest returns one saved request including its Data.
func (l *Library) GetRequest(id int64) (SavedRequest, error) {
	r := SavedRequest{ID: id}
	var data string
	err := l.db.QueryRow(`SELECT collection_id, folder_id, name, method, url, data, updated_at FROM requests WHERE id=?`, id).
		Scan(&r.CollectionID, &r.FolderID, &r.Name, &r.Method, &r.URL, &data, &r.UpdatedAt)
	r.Data = json.RawMessage(data)
	return r, err
}

// DeleteRequest deletes one saved request.
func (l *Library) DeleteRequest(id int64) error {
	return affected(l.db.Exec(`DELETE FROM requests WHERE id=?`, id))
}

// RenameRequest renames a saved request.
func (l *Library) RenameRequest(id int64, name string) error {
	return affected(l.db.Exec(`UPDATE requests SET name=?, updated_at=? WHERE id=?`, name, now(), id))
}

// MoveRequest moves a saved request to a collection and/or folder (both nil = loose).
func (l *Library) MoveRequest(id int64, collectionID, folderID *int64) error {
	cid, err := l.placement(collectionID, folderID)
	if err != nil {
		return err
	}
	_, err = l.db.Exec(`UPDATE requests SET collection_id=?, folder_id=?, updated_at=? WHERE id=?`, cid, folderID, now(), id)
	if err != nil && strings.Contains(err.Error(), "FOREIGN KEY") {
		return ErrUnknownCollection
	}
	if err != nil {
		return err
	}
	var one int
	return l.db.QueryRow(`SELECT 1 FROM requests WHERE id=?`, id).Scan(&one)
}

// CreateFolder adds a folder to a collection, or inside parent (whose collection wins).
func (l *Library) CreateFolder(collectionID int64, parentID *int64, name string) (int64, error) {
	if parentID != nil {
		cid, err := l.placement(nil, parentID)
		if err != nil {
			return 0, err
		}
		collectionID = *cid
	}
	res, err := l.db.Exec(`INSERT INTO folders(collection_id, parent_id, name) VALUES(?,?,?)`, collectionID, parentID, name)
	if err != nil && strings.Contains(err.Error(), "FOREIGN KEY") {
		return 0, ErrUnknownCollection
	}
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// RenameFolder renames a folder.
func (l *Library) RenameFolder(id int64, name string) error {
	return affected(l.db.Exec(`UPDATE folders SET name=? WHERE id=?`, name, id))
}

// subtree selects a folder and every folder under it (bind the root id).
const subtree = `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id) `

// MoveFolder moves a folder (with everything under it) to a collection's
// root, or inside parentID (whose collection wins).
func (l *Library) MoveFolder(id, collectionID int64, parentID *int64) error {
	tx, err := l.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if parentID != nil {
		var n int
		if err := tx.QueryRow(subtree+`SELECT count(*) FROM sub WHERE id = ?`, id, *parentID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrFolderCycle
		}
		if err := tx.QueryRow(`SELECT collection_id FROM folders WHERE id=?`, *parentID).Scan(&collectionID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnknownFolder
			}
			return err
		}
	}
	res, err := tx.Exec(`UPDATE folders SET parent_id=?, collection_id=? WHERE id=?`, parentID, collectionID, id)
	if err != nil && strings.Contains(err.Error(), "FOREIGN KEY") {
		return ErrUnknownCollection
	}
	if err := affected(res, err); err != nil {
		return err
	}
	// Everything under the folder follows it into the new collection.
	if _, err := tx.Exec(subtree+`UPDATE folders SET collection_id=? WHERE id IN sub`, id, collectionID); err != nil {
		return err
	}
	if _, err := tx.Exec(subtree+`UPDATE requests SET collection_id=? WHERE folder_id IN sub`, id, collectionID); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteFolder deletes a folder with its sub-folders and requests.
func (l *Library) DeleteFolder(id int64) error {
	return affected(l.db.Exec(`DELETE FROM folders WHERE id=?`, id))
}

// Tree lists every collection, folder and saved request (without Data), by name.
func (l *Library) Tree() ([]Collection, []Folder, []SavedRequest, error) {
	cols := []Collection{}
	if err := l.each(`SELECT id, name FROM collections ORDER BY name COLLATE NOCASE, id`, func(sc func(...any) error) error {
		var c Collection
		err := sc(&c.ID, &c.Name)
		cols = append(cols, c)
		return err
	}); err != nil {
		return nil, nil, nil, err
	}
	folders := []Folder{}
	if err := l.each(`SELECT id, collection_id, parent_id, name FROM folders ORDER BY name COLLATE NOCASE, id`, func(sc func(...any) error) error {
		var f Folder
		err := sc(&f.ID, &f.CollectionID, &f.ParentID, &f.Name)
		folders = append(folders, f)
		return err
	}); err != nil {
		return nil, nil, nil, err
	}
	reqs := []SavedRequest{}
	err := l.each(`SELECT id, collection_id, folder_id, name, method, url, updated_at FROM requests ORDER BY name COLLATE NOCASE, id`, func(sc func(...any) error) error {
		var r SavedRequest
		err := sc(&r.ID, &r.CollectionID, &r.FolderID, &r.Name, &r.Method, &r.URL, &r.UpdatedAt)
		reqs = append(reqs, r)
		return err
	})
	return cols, folders, reqs, err
}

// each runs query and calls row once per result row with that row's Scan.
func (l *Library) each(query string, row func(scan func(...any) error) error) error {
	rows, err := l.db.Query(query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := row(rows.Scan); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Environment is a named set of {{variables}}. Vars is the UI's row list, stored as-is.
type Environment struct {
	ID   int64           `json:"id"`
	Name string          `json:"name"`
	Vars json.RawMessage `json:"vars"`
}

// SaveEnvironment inserts e when e.ID is 0, otherwise updates it (sql.ErrNoRows if missing).
func (l *Library) SaveEnvironment(e Environment) (int64, error) {
	if e.ID == 0 {
		res, err := l.db.Exec(`INSERT INTO environments(name, vars) VALUES(?,?)`, e.Name, string(e.Vars))
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	}
	return e.ID, affected(l.db.Exec(`UPDATE environments SET name=?, vars=? WHERE id=?`, e.Name, string(e.Vars), e.ID))
}

// Environments lists every environment with its variables, by name.
func (l *Library) Environments() ([]Environment, error) {
	rows, err := l.db.Query(`SELECT id, name, vars FROM environments ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Environment{}
	for rows.Next() {
		var e Environment
		var vars string
		if err := rows.Scan(&e.ID, &e.Name, &vars); err != nil {
			return nil, err
		}
		e.Vars = json.RawMessage(vars)
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteEnvironment deletes one environment.
func (l *Library) DeleteEnvironment(id int64) error {
	return affected(l.db.Exec(`DELETE FROM environments WHERE id=?`, id))
}

// ImportRequest is a request to import plus the folder path it sits in.
type ImportRequest struct {
	SavedRequest
	Folder []string `json:"folder"`
}

// ImportCollection creates a collection holding reqs (and their folders), all or nothing.
func (l *Library) ImportCollection(name string, reqs []ImportRequest) (int64, error) {
	tx, err := l.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() // no-op after Commit
	res, err := tx.Exec(`INSERT INTO collections(name) VALUES(?)`, name)
	if err != nil {
		return 0, err
	}
	cid, _ := res.LastInsertId()
	at := now()
	folders := map[string]int64{} // "a\x00b" path → folder id
	for _, r := range reqs {
		if r.Data == nil {
			return 0, errors.New("request " + r.Name + " has no data")
		}
		var parent *int64
		key := ""
		for _, f := range r.Folder {
			key += "\x00" + f
			id, ok := folders[key]
			if !ok {
				res, err := tx.Exec(`INSERT INTO folders(collection_id, parent_id, name) VALUES(?,?,?)`, cid, parent, f)
				if err != nil {
					return 0, err
				}
				id, _ = res.LastInsertId()
				folders[key] = id
			}
			parent = &id
		}
		if _, err := tx.Exec(`INSERT INTO requests(collection_id, folder_id, name, method, url, data, updated_at) VALUES(?,?,?,?,?,?,?)`,
			cid, parent, r.Name, r.Method, r.URL, string(r.Data), at); err != nil {
			return 0, err
		}
	}
	return cid, tx.Commit()
}

// AddHistory records a sent request and drops the oldest past historyLimit.
func (l *Library) AddHistory(h HistoryEntry) error {
	if _, err := l.db.Exec(`INSERT INTO history(at, method, url, status, time_ms, size, error, data) VALUES(?,?,?,?,?,?,?,?)`,
		now(), h.Method, h.URL, h.Status, h.TimeMs, h.Size, h.Error, string(h.Data)); err != nil {
		return err
	}
	_, err := l.db.Exec(`DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?)`, historyLimit)
	return err
}

// History returns the kept history, newest first, without Data (bodies can
// be large; GetHistory fetches one entry's).
func (l *Library) History() ([]HistoryEntry, error) {
	rows, err := l.db.Query(`SELECT id, at, method, url, status, time_ms, size, error FROM history ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryEntry{}
	for rows.Next() {
		var h HistoryEntry
		if err := rows.Scan(&h.ID, &h.At, &h.Method, &h.URL, &h.Status, &h.TimeMs, &h.Size, &h.Error); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// GetHistory returns one history entry including what was sent.
func (l *Library) GetHistory(id int64) (HistoryEntry, error) {
	h := HistoryEntry{ID: id}
	var data string
	err := l.db.QueryRow(`SELECT at, method, url, status, time_ms, size, error, data FROM history WHERE id=?`, id).
		Scan(&h.At, &h.Method, &h.URL, &h.Status, &h.TimeMs, &h.Size, &h.Error, &data)
	h.Data = json.RawMessage(data)
	return h, err
}

// ClearHistory deletes all history.
func (l *Library) ClearHistory() error {
	_, err := l.db.Exec(`DELETE FROM history`)
	return err
}
