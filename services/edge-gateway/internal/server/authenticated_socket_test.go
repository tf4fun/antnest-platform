package server

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestWorkspaceBridgeUsesReloadedWorkloadCredentialAndPrivateContext(t *testing.T) {
	credentials := make(chan string, 2)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		values := r.Header.Values(serviceauth.Header)
		if len(values) != 1 || r.Header.Get(identity.CallerContextHeader) != "trusted-issuer-context" ||
			r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" ||
			r.URL.Path != "/api/app/workspace/v1/agents/agent-1/commands" || r.Method != http.MethodPost {
			t.Error("Bridge did not carry only trusted workload credentials and unchanged issuer context")
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		select {
		case credentials <- values[0]:
		default:
			t.Error("unexpected extra authenticated Bridge request")
			http.Error(w, "unexpected request", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
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
	file := filepath.Join(dir, "agent-ui")
	if err := os.WriteFile(file, []byte(first), 0600); err != nil {
		t.Fatal(err)
	}
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir, "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers}
	clients, err := serviceauth.LoadOutbound("edge-gateway", serviceauth.GatewayHeaders, func(name string) (string, bool) { v, ok := env[name]; return v, ok }, map[string]string{"agent-ui": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	h := newTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, http.NotFoundHandler(), time.Now()).(*handler)
	h.agentUIURL, _ = url.Parse(upstream.URL)
	h.httpClient = &http.Client{Transport: telemetry.NewHTTPTransport(clients)}
	h.workspaceBridgeProxy = h.newWorkspaceBridgeProxy(h.agentUIURL)
	post := func() int {
		r := newBrowserRequest(http.MethodPost, "/api/app/workspace/v1/agents/agent-1/commands", strings.NewReader(`{"command":"stop"}`))
		addSessionCookies(r, "token-1", testCSRFToken)
		r.Header.Set(session.CSRFHeaderName, testCSRFToken)
		r.Header.Set(serviceauth.Header, "Bearer forged-workload")
		r.Header.Set(identity.CallerContextHeader, "forged-context")
		r.Header.Set("Authorization", "Bearer forged-browser")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, r)
		return response.Code
	}
	if status := post(); status != http.StatusNoContent {
		t.Fatalf("first Bridge request status=%d", status)
	}
	if err := os.WriteFile(file+".next", []byte(second), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file+".next", file); err != nil {
		t.Fatal(err)
	}
	if status := post(); status != http.StatusNoContent {
		t.Fatalf("rotated Bridge request status=%d", status)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if status := post(); status != http.StatusServiceUnavailable || calls.Load() != 2 {
		t.Fatalf("missing Bridge credential reused a token: status=%d upstream=%d", status, calls.Load())
	}
	if len(credentials) != 2 || <-credentials != "Bearer "+first || <-credentials != "Bearer "+second {
		t.Fatal("Bridge rotation did not match outgoing files")
	}
}
