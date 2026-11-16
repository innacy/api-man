package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"apiperf/store"
)

const (
	maxLibraryBody = 10 << 20 // one saved request's JSON
	maxHistoryBody = 1 << 20  // request bodies larger than this aren't kept in history
	maxNameLen     = 200
)

func (s *server) libraryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library", s.handleLibrary)
	mux.HandleFunc("POST /api/collections", s.handleCreateCollection)
	mux.HandleFunc("PUT /api/collections/{id}", s.handleRenameCollection)
	mux.HandleFunc("DELETE /api/collections/{id}", s.handleDeleteCollection)
	mux.HandleFunc("POST /api/requests", s.handleSaveRequest)
	mux.HandleFunc("GET /api/requests/{id}", s.handleGetRequest)
	mux.HandleFunc("PUT /api/requests/{id}", s.handleSaveRequest)
	mux.HandleFunc("PATCH /api/requests/{id}", s.handlePatchRequest)
	mux.HandleFunc("DELETE /api/requests/{id}", s.handleDeleteRequest)
	mux.HandleFunc("POST /api/folders", s.handleCreateFolder)
	mux.HandleFunc("PUT /api/folders/{id}", s.handleRenameFolder)
	mux.HandleFunc("PATCH /api/folders/{id}", s.handleMoveFolder)
	mux.HandleFunc("DELETE /api/folders/{id}", s.handleDeleteFolder)
	mux.HandleFunc("GET /api/history", s.handleHistory)
	mux.HandleFunc("GET /api/history/{id}", s.handleGetHistory)
	mux.HandleFunc("DELETE /api/history", s.handleClearHistory)
	mux.HandleFunc("GET /api/environments", s.handleEnvironments)
	mux.HandleFunc("POST /api/environments", s.handleSaveEnvironment)
	mux.HandleFunc("PUT /api/environments/{id}", s.handleSaveEnvironment)
	mux.HandleFunc("DELETE /api/environments/{id}", s.handleDeleteEnvironment)
	mux.HandleFunc("POST /api/import", s.handleImport)
	mux.HandleFunc("PUT /api/collections/{id}/meta", s.handleSetMeta("collections"))
	mux.HandleFunc("PUT /api/folders/{id}/meta", s.handleSetMeta("folders"))
	mux.HandleFunc("GET /api/globals", s.handleGlobals)
	mux.HandleFunc("PUT /api/globals", s.handleSetGlobals)
}

func (s *server) handleEnvironments(w http.ResponseWriter, r *http.Request) {
	envs, err := s.lib.Environments()
	if err != nil {
		writeStoreErr(w, "environments", err)
		return
	}
	writeJSON(w, http.StatusOK, envs)
}

// checkEnv validates an environment's name and that Vars is a JSON list.
func checkEnv(e *store.Environment) string {
	var ok bool
	if e.Name, ok = cleanName(e.Name); !ok {
		return "name must be 1-200 characters"
	}
	if len(e.Vars) == 0 || e.Vars[0] != '[' {
		return "vars must be a JSON list"
	}
	return ""
}

func (s *server) handleSaveEnvironment(w http.ResponseWriter, r *http.Request) {
	var e store.Environment
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLibraryBody)).Decode(&e); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	e.ID = 0
	if r.Method == http.MethodPut {
		id, ok := pathInt64(r, "id")
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		e.ID = id
	}
	if msg := checkEnv(&e); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id, err := s.lib.SaveEnvironment(e)
	if err != nil {
		writeStoreErr(w, "environment", err)
		return
	}
	status := http.StatusOK
	if e.ID == 0 {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"id": id})
}

func (s *server) handleDeleteEnvironment(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.lib.DeleteEnvironment(id); err != nil {
		writeStoreErr(w, "environment", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleImport stores an already-converted collection (the UI converts
// Postman files) and, optionally, its variables as an environment.
func (s *server) handleImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string                     `json:"name"`
		Meta        json.RawMessage            `json:"meta"`
		FolderMeta  map[string]json.RawMessage `json:"folderMeta"` // "\x00a\x00b" folder path → meta
		Requests    []store.ImportRequest      `json:"requests"`
		Environment *store.Environment         `json:"environment"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 50<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "collection name must be 1-200 characters")
		return
	}
	for i := range req.Requests {
		rq := &req.Requests[i]
		if rq.Name, ok = cleanName(rq.Name); !ok {
			rq.Name = "Untitled request"
		}
		if len(rq.Data) == 0 || rq.Data[0] != '{' {
			writeError(w, http.StatusBadRequest, "request "+rq.Name+": data must be a JSON object")
			return
		}
		for j, f := range rq.Folder {
			if rq.Folder[j], ok = cleanName(f); !ok {
				rq.Folder[j] = "Folder"
			}
		}
	}
	if req.Environment != nil {
		if msg := checkEnv(req.Environment); msg != "" {
			writeError(w, http.StatusBadRequest, "environment: "+msg)
			return
		}
	}
	for _, m := range append([]json.RawMessage{req.Meta}, mapValues(req.FolderMeta)...) {
		if len(m) > 0 && m[0] != '{' {
			writeError(w, http.StatusBadRequest, "meta must be a JSON object")
			return
		}
	}
	cid, err := s.lib.ImportCollection(name, req.Meta, req.FolderMeta, req.Requests)
	if err != nil {
		writeStoreErr(w, "import", err)
		return
	}
	out := map[string]any{"collectionId": cid}
	if req.Environment != nil {
		req.Environment.ID = 0
		eid, err := s.lib.SaveEnvironment(*req.Environment)
		if err != nil {
			writeStoreErr(w, "environment", err)
			return
		}
		out["environmentId"] = eid
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	h, err := s.lib.GetHistory(id)
	if err != nil {
		writeStoreErr(w, "history entry", err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}

// writeStoreErr maps a library error to a response: missing rows are 404,
// anything else is a server-side failure.
func writeStoreErr(w http.ResponseWriter, what string, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, what+" not found")
		return
	}
	log.Printf("server: %s: %v", what, err)
	writeError(w, http.StatusInternalServerError, "failed to update library")
}

func mapValues(m map[string]json.RawMessage) (out []json.RawMessage) {
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// handleSetMeta stores a collection's or folder's variables and scripts.
func (s *server) handleSetMeta(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathInt64(r, "id")
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		var meta json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLibraryBody)).Decode(&meta); err != nil || len(meta) == 0 || meta[0] != '{' {
			writeError(w, http.StatusBadRequest, "body must be a JSON object")
			return
		}
		if err := s.lib.SetMeta(kind, id, meta); err != nil {
			writeStoreErr(w, kind, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (s *server) handleGlobals(w http.ResponseWriter, r *http.Request) {
	vars, err := s.lib.Globals()
	if err != nil {
		writeStoreErr(w, "globals", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vars": vars})
}

func (s *server) handleSetGlobals(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Vars json.RawMessage `json:"vars"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLibraryBody)).Decode(&req); err != nil || len(req.Vars) == 0 || req.Vars[0] != '[' {
		writeError(w, http.StatusBadRequest, "vars must be a JSON list")
		return
	}
	if err := s.lib.SetGlobals(req.Vars); err != nil {
		writeStoreErr(w, "globals", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// cleanName trims a user-entered name and checks it fits.
func cleanName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, name != "" && len(name) <= maxNameLen
}

func (s *server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	cols, folders, reqs, err := s.lib.Tree()
	if err != nil {
		writeStoreErr(w, "library", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"collections": cols, "folders": folders, "requests": reqs})
}

func (s *server) handleCreateCollection(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	id, err := s.lib.CreateCollection(name)
	if err != nil {
		writeStoreErr(w, "collection", err)
		return
	}
	writeJSON(w, http.StatusCreated, store.Collection{ID: id, Name: name})
}

func (s *server) handleRenameCollection(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct{ Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	if err := s.lib.RenameCollection(id, name); err != nil {
		writeStoreErr(w, "collection", err)
		return
	}
	writeJSON(w, http.StatusOK, store.Collection{ID: id, Name: name})
}

func (s *server) handleDeleteCollection(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.lib.DeleteCollection(id); err != nil {
		writeStoreErr(w, "collection", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleSaveRequest creates (POST) or replaces (PUT /{id}) a saved request.
func (s *server) handleSaveRequest(w http.ResponseWriter, r *http.Request) {
	var req store.SavedRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLibraryBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	req.ID = 0
	if r.Method == http.MethodPut {
		id, ok := pathInt64(r, "id")
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid id")
			return
		}
		req.ID = id
	}
	var ok bool
	if req.Name, ok = cleanName(req.Name); !ok {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	if req.Method == "" || req.URL == "" {
		writeError(w, http.StatusBadRequest, "method and url are required")
		return
	}
	if len(req.Data) == 0 || req.Data[0] != '{' {
		writeError(w, http.StatusBadRequest, "data must be a JSON object")
		return
	}
	id, err := s.lib.SaveRequest(req)
	if writePlacementErr(w, err) {
		return
	}
	if err != nil {
		writeStoreErr(w, "request", err)
		return
	}
	status := http.StatusOK
	if req.ID == 0 {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"id": id})
}

func (s *server) handleGetRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	req, err := s.lib.GetRequest(id)
	if err != nil {
		writeStoreErr(w, "request", err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}

func (s *server) handleDeleteRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.lib.DeleteRequest(id); err != nil {
		writeStoreErr(w, "request", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (s *server) handleHistory(w http.ResponseWriter, r *http.Request) {
	h, err := s.lib.History()
	if err != nil {
		writeStoreErr(w, "history", err)
		return
	}
	writeJSON(w, http.StatusOK, h)
}

func (s *server) handleClearHistory(w http.ResponseWriter, r *http.Request) {
	if err := s.lib.ClearHistory(); err != nil {
		writeStoreErr(w, "history", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cleared": true})
}

// writePlacementErr reports a bad collection/folder target as a 400.
func writePlacementErr(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, store.ErrUnknownCollection):
		writeError(w, http.StatusBadRequest, "collection does not exist")
	case errors.Is(err, store.ErrUnknownFolder):
		writeError(w, http.StatusBadRequest, "folder does not exist")
	case errors.Is(err, store.ErrFolderCycle):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		return false
	}
	return true
}

// handlePatchRequest renames ({"name"}) and/or moves ({"move":{"collectionId","folderId"}})
// a saved request without resending its form data.
func (s *server) handlePatchRequest(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Name *string `json:"name"`
		Move *struct {
			CollectionID *int64 `json:"collectionId"`
			FolderID     *int64 `json:"folderId"`
		} `json:"move"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Name != nil {
		name, ok := cleanName(*req.Name)
		if !ok {
			writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
			return
		}
		if err := s.lib.RenameRequest(id, name); err != nil {
			writeStoreErr(w, "request", err)
			return
		}
	}
	if req.Move != nil {
		err := s.lib.MoveRequest(id, req.Move.CollectionID, req.Move.FolderID)
		if writePlacementErr(w, err) {
			return
		}
		if err != nil {
			writeStoreErr(w, "request", err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CollectionID int64  `json:"collectionId"`
		ParentID     *int64 `json:"parentId"`
		Name         string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	id, err := s.lib.CreateFolder(req.CollectionID, req.ParentID, name)
	if writePlacementErr(w, err) {
		return
	}
	if err != nil {
		writeStoreErr(w, "folder", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *server) handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct{ Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name, ok := cleanName(req.Name)
	if !ok {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	if err := s.lib.RenameFolder(id, name); err != nil {
		writeStoreErr(w, "folder", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.lib.DeleteFolder(id); err != nil {
		writeStoreErr(w, "folder", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleMoveFolder moves a folder: {"move":{"collectionId","parentId"}}.
func (s *server) handleMoveFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt64(r, "id")
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Move *struct {
			CollectionID int64  `json:"collectionId"`
			ParentID     *int64 `json:"parentId"`
		} `json:"move"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.Move == nil {
		writeError(w, http.StatusBadRequest, "body must be {\"move\":{...}}")
		return
	}
	err := s.lib.MoveFolder(id, req.Move.CollectionID, req.Move.ParentID)
	if writePlacementErr(w, err) {
		return
	}
	if err != nil {
		writeStoreErr(w, "folder", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}
