package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestACPWebSocketHandshakeUsesReloadedWorkloadCredentialAndPrivateContext(t *testing.T) {
	var credentials []string
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values(serviceauth.Header)
		if len(values) != 1 || r.Header.Get(identity.CallerContextHeader) != "trusted-issuer-context" {
			t.Error("WebSocket did not carry one workload credential and unchanged issuer context")
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		credentials = append(credentials, values[0])
		connection, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			_ = connection.Close()
		}
	}))
	defer upstream.Close()
	dir := t.TempDir()
	newToken := func() string {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	first, second := newToken(), newToken()
	file := filepath.Join(dir, "agent-acp-service")
	if err := os.WriteFile(file, []byte(first), 0600); err != nil {
		t.Fatal(err)
	}
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir, "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers}
	clients, err := serviceauth.LoadOutbound(func(name string) (string, bool) { v, ok := env[name]; return v, ok }, map[string]string{"agent-acp-service": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	h := newTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, http.NotFoundHandler(), time.Now()).(*handler)
	h.agentACPURL, _ = url.Parse(upstream.URL)
	h.httpClient = &http.Client{Transport: telemetry.NewHTTPTransport(clients)}
	dial := func() error {
		r := httptest.NewRequest("GET", "/api/app/agents/agent-1/acp", nil)
		r.SetPathValue("agent_id", "agent-1")
		r.SetPathValue("acp_version", "v1")
		r = r.WithContext(identity.WithPrincipal(context.Background(), ordinaryPrincipal()))
		connection, _, err := h.dialWorkspaceACP(r, ordinaryPrincipal())
		if connection != nil {
			_ = connection.Close()
		}
		return err
	}
	if err := dial(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file+".next", []byte(second), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file+".next", file); err != nil {
		t.Fatal(err)
	}
	if err := dial(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if dial() == nil {
		t.Fatal("missing WebSocket credential used a stale token")
	}
	if len(credentials) != 2 || credentials[0] != "Bearer "+first || credentials[1] != "Bearer "+second {
		t.Fatal("WebSocket rotation did not match outgoing files")
	}
}
