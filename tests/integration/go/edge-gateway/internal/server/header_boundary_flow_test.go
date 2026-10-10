package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func boundaryNetworkGateway(t *testing.T, upstream http.Handler, principal identity.Principal) *httptest.Server {
	t.Helper()
	peer := httptest.NewServer(upstream)
	t.Cleanup(peer.Close)
	sessions, err := session.NewManager(session.Config{CSRFKey: []byte(testCSRFKey)})
	if err != nil {
		t.Fatal(err)
	}
	client := peer.Client()
	t.Cleanup(client.CloseIdleConnections)
	h, err := NewHandler(Config{
		AdminConsoleURL: peer.URL, AgentUIURL: peer.URL, AgentACPURL: peer.URL, IdentityURL: peer.URL,
		RequestTimeout: time.Second,
	}, Dependencies{
		Identity: &identityServiceStub{resolvePrincipal: principal}, Agents: &agentServiceStub{}, Execution: &executionServiceStub{},
		Sessions: sessions, HTTPClient: client, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	edge := httptest.NewServer(h)
	t.Cleanup(edge.Close)
	edge.Client().Timeout = 3 * time.Second
	t.Cleanup(edge.Client().CloseIdleConnections)
	return edge
}

func boundaryAttackHeaders(t *testing.T) http.Header {
	t.Helper()
	headers := make(http.Header)
	for _, field := range readHeaderBoundaryContract(t).Headers {
		headers.Add(field.Name, "forged")
		headers.Add(field.Name, "duplicate")
	}
	headers.Set("Antnest-Future-Authority", "forged")
	headers.Set("X-Antnest-Future-Privilege", "true")
	headers.Set("X-Unlisted-Browser-Header", "private")
	headers.Set("Authorization", "Bearer browser-private")
	return headers
}

func TestHeaderBoundaryDiscardsRealChunkedTrailers(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{"GET", "/"},
		{"POST", "/api/admin/agents"},
		{"POST", "/scim/v2/Users"},
		{"POST", "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts"},
		{"POST", "/api/app/agents/agent-1/v1/acp"},
	} {
		t.Run(route.path, func(t *testing.T) {
			var calls atomic.Int32
			edge := boundaryNetworkGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if len(r.Trailer) != 0 || r.Header.Get("Trailer") != "" {
					t.Error("browser trailer declarations crossed the real HTTP boundary")
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != `{"opaque":"payload"}` {
					t.Errorf("body=%q err=%v", body, err)
				}
				if len(r.Trailer) != 0 {
					t.Error("browser trailer values arrived after EOF")
				}
				w.WriteHeader(http.StatusNoContent)
			}), administratorPrincipal())
			r, err := http.NewRequest(route.method, edge.URL+route.path, io.NopCloser(strings.NewReader(`{"opaque":"payload"}`)))
			if err != nil {
				t.Fatal(err)
			}
			r.ContentLength = -1
			r.TransferEncoding = []string{"chunked"}
			r.Trailer = boundaryAttackHeaders(t)
			r.Trailer.Del("Authorization")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", edge.URL)
			r.Header.Set(session.CSRFHeaderName, testCSRFToken)
			addSessionCookies(r, "token-1", testCSRFToken)
			response, err := edge.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNoContent || calls.Load() != 1 {
				t.Fatalf("status=%d upstream calls=%d", response.StatusCode, calls.Load())
			}
		})
	}
}

func TestHeaderBoundaryRetainsOnlyDeclaredACPWebSocketAuthority(t *testing.T) {
	contract := readHeaderBoundaryContract(t)
	for _, route := range []struct{ path, upstream string }{
		{"/api/app/agents/agent-1/acp", "/v1/acp"},
		{"/api/app/agents/agent-1/v1/acp", "/v1/acp"},
		{"/api/app/agents/agent-1/v2/acp", "/v2/acp"},
	} {
		t.Run(route.path, func(t *testing.T) {
			received := make(chan http.Header, 1)
			upgrader := websocket.Upgrader{Subprotocols: []string{"acp-boundary"}}
			edge := boundaryNetworkGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != route.upstream {
					t.Errorf("upstream path=%s", r.URL.Path)
				}
				received <- r.Header.Clone()
				connection, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer func() { _ = connection.Close() }()
				_ = connection.WriteMessage(websocket.TextMessage, []byte("connected"))
			}), ordinaryPrincipal())
			headers := boundaryAttackHeaders(t)
			headers.Set("Origin", edge.URL)
			headers.Set("Cookie", "antnest_session=token-1")
			dialer := websocket.Dialer{HandshakeTimeout: time.Second, Subprotocols: []string{"acp-boundary"}}
			connection, response, err := dialer.Dial(strings.Replace(edge.URL, "http:", "ws:", 1)+route.path, headers)
			if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = connection.Close() }()
			if connection.Subprotocol() != "acp-boundary" {
				t.Fatal("declared WebSocket subprotocol was lost")
			}
			_ = connection.SetReadDeadline(time.Now().Add(time.Second))
			_, payload, err := connection.ReadMessage()
			if err != nil || string(payload) != "connected" {
				t.Fatalf("relay payload=%q err=%v", payload, err)
			}
			expected := map[string][]string{
				HeaderOrganizationID: {"org-1"}, HeaderPrincipalID: {"user-admin"}, HeaderAgentID: {"agent-1"},
				identity.CallerContextHeader: {"trusted-issuer-context"},
			}
			select {
			case actual := <-received:
				for _, field := range contract.Headers {
					if got := boundaryHeaderValues(actual, field.Name); !reflect.DeepEqual(got, expected[field.Name]) {
						t.Errorf("%s: got %v, want %v", field.Name, got, expected[field.Name])
					}
				}
				for _, name := range []string{"Cookie", "Authorization", "Origin", "Antnest-Future-Authority", "X-Antnest-Future-Privilege", "X-Unlisted-Browser-Header"} {
					if len(boundaryHeaderValues(actual, name)) != 0 {
						t.Errorf("browser field reached ACP handshake: %s", name)
					}
				}
			case <-time.After(time.Second):
				t.Fatal("ACP handshake was not observed")
			}
		})
	}
}

func TestHeaderBoundaryGenericHTTPRoutesDoNotForwardUpgrade(t *testing.T) {
	for _, path := range []string{
		"/proxy-socket", "/api/admin/agents", "/workspace/", "/workspace/assets/socket",
		"/api/app/workspace/v1/agents/agent-1/configuration", "/scim/v2/Users",
	} {
		t.Run(path, func(t *testing.T) {
			var calls atomic.Int32
			edge := boundaryNetworkGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				for _, name := range []string{"Connection", "Upgrade", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions"} {
					if r.Header.Get(name) != "" {
						t.Errorf("undeclared handshake field forwarded: %s", name)
					}
				}
				w.WriteHeader(http.StatusOK)
			}), administratorPrincipal())
			r, err := http.NewRequest(http.MethodGet, edge.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			addSessionCookies(r, "token-1", testCSRFToken)
			r.Header.Set("Origin", edge.URL)
			r.Header.Set("Connection", "Upgrade")
			r.Header.Set("Upgrade", "websocket")
			r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
			r.Header.Set("Sec-WebSocket-Version", "13")
			r.Header.Set("Sec-WebSocket-Protocol", "undeclared")
			r.Header.Set("Sec-WebSocket-Extensions", "permessage-deflate")
			response, err := edge.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK || calls.Load() != 1 {
				t.Fatalf("status=%d upstream calls=%d", response.StatusCode, calls.Load())
			}
		})
	}
}

func TestHeaderBoundaryLocalHandlersConstructTypedDownstreamRequests(t *testing.T) {
	contract := readHeaderBoundaryContract(t)
	now := time.Now()
	issued := sessionFlowContext("token-1", now.Unix(), 1)
	observed := make(chan string, 32)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- r.URL.Path
		expected := map[string][]string{}
		if strings.HasPrefix(r.URL.Path, "/rpc/agent-controller/") || strings.HasPrefix(r.URL.Path, "/rpc/agent-acp/") {
			expected[identity.CallerContextHeader] = []string{issued}
		}
		if strings.HasPrefix(r.URL.Path, "/rpc/agent-acp/") {
			expected[HeaderOrganizationID] = []string{"org-1"}
			expected[HeaderPrincipalID] = []string{"user-admin"}
			expected[HeaderAgentID] = []string{"agent-1"}
		}
		for _, field := range contract.Headers {
			if got := boundaryHeaderValues(r.Header, field.Name); !reflect.DeepEqual(got, expected[field.Name]) {
				t.Errorf("%s: header %s got %v, want %v", r.URL.Path, field.Name, got, expected[field.Name])
			}
		}
		for _, name := range []string{"Cookie", "Authorization", "Antnest-Future-Authority", "X-Antnest-Future-Privilege", "X-Unlisted-Browser-Header"} {
			if len(boundaryHeaderValues(r.Header, name)) != 0 {
				t.Errorf("%s forwarded browser field %s", r.URL.Path, name)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/rpc/identity/local-login":
			_ = json.NewEncoder(w).Encode(identity.LoginResult{Principal: ordinaryPrincipal(), TokenID: "token-1", AccessToken: "private-token", ExpiresAt: now.Add(time.Hour)})
		case "/rpc/identity/list-login-methods":
			_ = json.NewEncoder(w).Encode(map[string]any{"methods": []identity.LoginMethod{{Name: "fixture", DisplayName: "Fixture"}}})
		case "/rpc/identity/start-oidc-login":
			_ = json.NewEncoder(w).Encode(identity.StartOIDCLoginResult{AuthorizationURL: "https://issuer.example/authorize?state=bound-state", ExpiresAt: now.Add(time.Minute)})
		case "/protocol/oidc/callback":
			if r.Method != http.MethodGet || r.URL.Query().Get("state") != "bound-state" || r.URL.Query().Get("code") != "fixture-code" {
				t.Error("typed OIDC callback lost protocol parameters")
			}
			_ = json.NewEncoder(w).Encode(identity.OIDCCallbackResult{Principal: ordinaryPrincipal(), TokenID: "token-1", AccessToken: "private-token", ExpiresAt: now.Add(time.Hour)})
		case "/rpc/identity/resolve-access-token":
			_ = json.NewEncoder(w).Encode(map[string]any{"principal": ordinaryPrincipal(), "caller_context": issued})
		case "/rpc/identity/revoke-access-token":
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
		case "/rpc/agent-controller/list-workspace-agents":
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": []agentcontroller.WorkspaceAgent{}})
		case "/rpc/agent-acp/get-agent-execution-state":
			_ = json.NewEncoder(w).Encode(readyState())
		case "/rpc/agent-acp/watch-agent-execution-state":
			w.Header().Set("Content-Type", "text/event-stream")
			body, _ := json.Marshal(readyState())
			for range 2 {
				_, _ = fmt.Fprintf(w, "event: workspace_state\ndata: %s\n\n", body)
				_ = http.NewResponseController(w).Flush()
			}
		default:
			t.Errorf("unexpected typed downstream path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(peer.Close)
	internalClient := peer.Client()
	t.Cleanup(internalClient.CloseIdleConnections)
	issuer, err := identity.NewClient(peer.URL, internalClient)
	if err != nil {
		t.Fatal(err)
	}
	agents, err := agentcontroller.NewClient(peer.URL, internalClient)
	if err != nil {
		t.Fatal(err)
	}
	execution, err := agentacp.NewClient(peer.URL, internalClient)
	if err != nil {
		t.Fatal(err)
	}
	h := newTestHandlerWithServices(t, issuer, agents, execution, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("local handler unexpectedly invoked a proxy")
	}), now, Config{})
	edge := httptest.NewServer(h)
	t.Cleanup(edge.Close)
	client := edge.Client()
	client.Timeout = 3 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	t.Cleanup(client.CloseIdleConnections)
	var oidcCookie *http.Cookie
	for _, route := range []struct {
		method, path, body string
		status             int
		downstream         []string
	}{
		{"POST", "/api/session/login", `{"organization_slug":"engineering","email":"member@example.test","password":"fixture"}`, 200, []string{"/rpc/identity/local-login"}},
		{"POST", "/api/session/login-methods", `{"organization_slug":"engineering"}`, 200, []string{"/rpc/identity/list-login-methods"}},
		{"POST", "/api/session/oidc/start", `{"organization_slug":"engineering","provider_name":"fixture"}`, 200, []string{"/rpc/identity/start-oidc-login"}},
		{"GET", "/protocol/oidc/callback?state=bound-state&code=fixture-code", "", 303, []string{"/protocol/oidc/callback"}},
		{"GET", "/api/session", "", 200, []string{"/rpc/identity/resolve-access-token"}},
		{"GET", "/api/app/bootstrap", "", 200, []string{"/rpc/identity/resolve-access-token", "/rpc/agent-controller/list-workspace-agents"}},
		{"GET", "/api/app/agents/agent-1/state", "", 200, []string{"/rpc/identity/resolve-access-token", "/rpc/agent-acp/get-agent-execution-state"}},
		{"GET", "/api/app/agents/agent-1/state/watch", "", 200, []string{"/rpc/identity/resolve-access-token", "/rpc/agent-acp/watch-agent-execution-state", "/rpc/identity/resolve-access-token"}},
		{"DELETE", "/api/session", "", 204, []string{"/rpc/identity/resolve-access-token", "/rpc/identity/revoke-access-token"}},
		{"GET", "/status", "", 200, nil},
		{"GET", "/workspace", "", 307, nil},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			r, err := http.NewRequest(route.method, edge.URL+route.path, strings.NewReader(route.body))
			if err != nil {
				t.Fatal(err)
			}
			r.Header = boundaryAttackHeaders(t)
			r.Header.Set("Origin", edge.URL)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set(session.CSRFHeaderName, testCSRFToken)
			addSessionCookies(r, "private-token", testCSRFToken)
			if strings.HasPrefix(route.path, "/protocol/oidc/callback") {
				if oidcCookie == nil {
					t.Fatal("OIDC start omitted browser binding")
				}
				r.AddCookie(oidcCookie)
			}
			response, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != route.status {
				t.Fatalf("status=%d body=%s err=%v", response.StatusCode, body, err)
			}
			if route.path == "/api/session/oidc/start" {
				for _, cookie := range response.Cookies() {
					if cookie.Name == session.OIDCCookieName {
						oidcCookie = cookie
					}
				}
			}
			if strings.HasSuffix(route.path, "/watch") && strings.Count(string(body), "event: workspace_state") != 2 {
				t.Fatal("state watch did not emit both snapshots and revalidate")
			}
			for _, expected := range route.downstream {
				select {
				case path := <-observed:
					if path != expected {
						t.Errorf("downstream path=%s, want %s", path, expected)
					}
				case <-time.After(time.Second):
					t.Fatalf("downstream path was not reached: %s", expected)
				}
			}
			select {
			case path := <-observed:
				t.Errorf("unexpected additional downstream request: %s", path)
			default:
			}
		})
	}
}
