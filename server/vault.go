package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// VaultPath is where the master-password hash lives (set by main). Empty
// disables the gate (tests). Like MQLens: one-time setup, unlock on every
// launch, reset wipes saved data. The session lives in memory, so a restart locks.
// ponytail: gate only — the library DB is not encrypted at rest; add that if needed.
var VaultPath string

type vaultMeta struct {
	Salt string `json:"salt"`
	Hash string `json:"hash"`
}

const vaultCookie = "apiman_vault"

type vault struct {
	mu    sync.Mutex
	token string
}

func vaultHash(pw string, salt []byte) []byte {
	return argon2.IDKey([]byte(pw), salt, 3, 64*1024, 2, 32)
}

func readVault() (*vaultMeta, error) {
	b, err := os.ReadFile(VaultPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m vaultMeta
	return &m, json.Unmarshal(b, &m)
}

func (v *vault) unlocked(r *http.Request) bool {
	c, err := r.Cookie(vaultCookie)
	v.mu.Lock()
	defer v.mu.Unlock()
	return err == nil && v.token != "" && subtle.ConstantTimeCompare([]byte(c.Value), []byte(v.token)) == 1
}

func (v *vault) grant(w http.ResponseWriter) {
	b := make([]byte, 32)
	rand.Read(b)
	v.mu.Lock()
	v.token = hex.EncodeToString(b)
	v.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: vaultCookie, Value: v.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
}

// vaultOpen are the routes usable while locked. Reset is open on purpose
// (forgot password) and so must wipe everything the gate protects.
var vaultOpen = map[string]bool{"/api/vault": true, "/api/vault/init": true, "/api/vault/unlock": true, "/api/vault/reset": true}

// gate blocks /api/* until unlocked, except the vault endpoints and ping.
func (v *vault) gate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if VaultPath == "" || !strings.HasPrefix(p, "/api/") || vaultOpen[p] || p == "/api/ping" || v.unlocked(r) {
			next.ServeHTTP(w, r)
			return
		}
		writeError(w, http.StatusUnauthorized, "locked")
	})
}

func (s *server) vaultRoutes(mux *http.ServeMux, v *vault) {
	mux.HandleFunc("GET /api/vault", func(w http.ResponseWriter, r *http.Request) {
		st := "unlocked"
		if VaultPath != "" && !v.unlocked(r) {
			m, err := readVault()
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			st = "locked"
			if m == nil {
				st = "uninitialized"
			}
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": st})
	})
	pw := func(w http.ResponseWriter, r *http.Request) (string, bool) {
		var body struct{ Password string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Password == "" {
			writeError(w, http.StatusBadRequest, "Master password is required")
			return "", false
		}
		return body.Password, true
	}
	mux.HandleFunc("POST /api/vault/init", func(w http.ResponseWriter, r *http.Request) {
		p, ok := pw(w, r)
		if !ok {
			return
		}
		if m, err := readVault(); err != nil || m != nil {
			writeError(w, http.StatusConflict, "Vault already initialized")
			return
		}
		salt := make([]byte, 16)
		rand.Read(salt)
		b, _ := json.Marshal(vaultMeta{hex.EncodeToString(salt), hex.EncodeToString(vaultHash(p, salt))})
		if err := os.WriteFile(VaultPath, b, 0o600); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		v.grant(w)
		writeJSON(w, http.StatusOK, map[string]string{"status": "unlocked"})
	})
	mux.HandleFunc("POST /api/vault/unlock", func(w http.ResponseWriter, r *http.Request) {
		p, ok := pw(w, r)
		if !ok {
			return
		}
		m, err := readVault()
		if err != nil || m == nil {
			writeError(w, http.StatusConflict, "Vault not initialized")
			return
		}
		salt, _ := hex.DecodeString(m.Salt)
		want, _ := hex.DecodeString(m.Hash)
		if subtle.ConstantTimeCompare(vaultHash(p, salt), want) != 1 {
			writeError(w, http.StatusUnauthorized, "Wrong master password")
			return
		}
		v.grant(w)
		writeJSON(w, http.StatusOK, map[string]string{"status": "unlocked"})
	})
	mux.HandleFunc("POST /api/vault/reset", func(w http.ResponseWriter, r *http.Request) {
		if err := errors.Join(s.lib.Reset(), s.st.Reset()); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := os.Remove(VaultPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		v.mu.Lock()
		v.token = ""
		v.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"status": "uninitialized"})
	})
}
