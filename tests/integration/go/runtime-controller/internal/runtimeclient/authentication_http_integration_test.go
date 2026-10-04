package runtimeclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestNativeStatusClientNeverProxiesRedirectsOrFallsBack(t *testing.T) {
	var traps, calls atomic.Int64
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { traps.Add(1); w.WriteHeader(500) }))
	t.Cleanup(trap.Close)
	proxyURL, _ := url.Parse(trap.URL)
	previous := http.DefaultTransport
	unsafe := previous.(*http.Transport).Clone()
	unsafe.Proxy = http.ProxyURL(proxyURL)
	http.DefaultTransport = unsafe
	t.Cleanup(func() { http.DefaultTransport = previous; unsafe.CloseIdleConnections() })
	t.Setenv("HTTP_PROXY", trap.URL)
	t.Setenv("HTTPS_PROXY", trap.URL)
	const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	path := filepath.Join(t.TempDir(), "antnest-runtime")
	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	var redirect atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get(serviceauth.Header) != "Bearer "+token || r.Header.Get("Authorization") != "" || r.Header.Get("Antnest-Caller-Context") != "" {
			t.Error("private status authority differs")
		}
		if redirect.Load() {
			http.Redirect(w, r, trap.URL, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent_id":"agent-1","generation":7,"execution_id":"exec-1","status":"ready"}`))
	}))
	t.Cleanup(server.Close)
	client, err := NewAuthenticated(&http.Client{}, time.Second, func(context.Context, deployment.Inspection) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	inspection := deployment.Inspection{AgentID: "agent-1", Generation: 7, StatusEndpoint: server.URL + "/status"}
	if _, err := client.Verify(context.Background(), inspection); err != nil {
		t.Fatal(err)
	}
	redirect.Store(true)
	if _, err := client.Verify(context.Background(), inspection); err == nil {
		t.Fatal("redirected status accepted")
	}
	if traps.Load() != 0 || calls.Load() != 2 {
		t.Fatal("private status went through redirect or proxy")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Verify(context.Background(), inspection); err == nil || calls.Load() != 2 {
		t.Fatal("missing sender fell back to cached or anonymous authority")
	}
}
