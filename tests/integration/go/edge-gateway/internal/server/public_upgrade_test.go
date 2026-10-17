package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func publicBoundaryGateway(t *testing.T, origin string, upstream http.Handler) (*httptest.Server, *bridgeLeaseIdentity, string) {
	t.Helper()
	peer := httptest.NewServer(upstream)
	t.Cleanup(peer.Close)
	secure := strings.HasPrefix(origin, "https:")
	sessions, err := session.NewManager(session.Config{Secure: secure, CSRFKey: []byte(testCSRFKey)})
	if err != nil {
		t.Fatal(err)
	}
	issuer := &bridgeLeaseIdentity{IdentityService: &identityServiceStub{}, principal: ordinaryPrincipal()}
	issuer.active.Store(true)
	h, err := NewHandler(Config{PublicOrigin: origin, AdminConsoleURL: peer.URL, AgentUIURL: peer.URL, IdentityURL: peer.URL}, Dependencies{Identity: issuer, Sessions: sessions, HTTPClient: peer.Client()})
	if err != nil {
		t.Fatal(err)
	}
	edge := httptest.NewServer(h)
	t.Cleanup(edge.Close)
	edge.Client().Timeout = 3 * time.Second
	cookie := "antnest_session=token-1"
	if secure {
		cookie = "__Host-" + cookie
	}
	return edge, issuer, cookie
}

func assertPublicHSTS(t *testing.T, origin string, headers http.Header) {
	t.Helper()
	values := headers.Values("Strict-Transport-Security")
	if strings.HasPrefix(origin, "https:") {
		if len(values) != 1 || values[0] != "max-age=31536000" {
			t.Fatalf("HTTPS HSTS=%v", values)
		}
	} else if len(values) != 0 {
		t.Fatalf("HTTP inherited HSTS=%v", values)
	}
}

func TestRetiredBrowserUpgradesRejectBeforeIdentityAndUpstream(t *testing.T) {
	for _, origin := range []string{"https://antnest.example", "http://127.0.0.1:8090"} {
		for _, suffix := range []string{"acp", "v1/acp", "v2/acp"} {
			for _, authenticated := range []bool{false, true} {
				t.Run(origin+"/"+suffix+"/session="+map[bool]string{false: "false", true: "true"}[authenticated], func(t *testing.T) {
					var calls atomic.Int32
					edge, issuer, cookie := publicBoundaryGateway(t, origin, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
					headers := boundaryAttackHeaders(t)
					headers.Set("Origin", origin)
					if authenticated {
						headers.Set("Cookie", cookie)
					}
					dialer := websocket.Dialer{HandshakeTimeout: time.Second, Subprotocols: []string{"acp-boundary"}}
					connection, response, err := dialer.Dial(strings.Replace(edge.URL, "http:", "ws:", 1)+"/api/app/agents/agent-1/"+suffix, headers)
					if connection != nil {
						_ = connection.Close()
						t.Fatal("retired browser route upgraded")
					}
					if response == nil {
						t.Fatalf("retired route returned no HTTP response: %v", err)
					}
					defer func() { _ = response.Body.Close() }()
					body, readErr := io.ReadAll(io.LimitReader(response.Body, 4096))
					if err == nil || readErr != nil || response.StatusCode != http.StatusNotFound || !strings.Contains(string(body), `"code":"not_found"`) {
						t.Fatalf("upgrade status=%d body=%s dial=%v read=%v", response.StatusCode, body, err, readErr)
					}
					if issuer.resolves.Load() != 0 || calls.Load() != 0 || len(response.Cookies()) != 0 || response.Header.Get("Upgrade") != "" {
						t.Fatalf("retired upgrade had effects: resolves=%d upstream=%d headers=%v", issuer.resolves.Load(), calls.Load(), response.Header)
					}
					assertPublicHSTS(t, origin, response.Header)
				})
			}
		}
	}
}

func TestRetainedWorkspaceResponsesKeepGatewayHSTSPolicy(t *testing.T) {
	for _, origin := range []string{"https://antnest.example", "http://127.0.0.1:8090"} {
		for _, path := range []string{"/api/app/workspace/v1/bootstrap", "/api/app/workspace/v1/agents/agent-1/events"} {
			t.Run(origin+path, func(t *testing.T) {
				var calls atomic.Int32
				payload := `{"agents":[]}`
				if strings.HasSuffix(path, "/events") {
					payload = "event: reset\ndata: {}\n\n"
				}
				edge, issuer, cookie := publicBoundaryGateway(t, origin, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if r.URL.Path != path {
						t.Errorf("upstream path=%s", r.URL.Path)
					}
					w.Header().Add("Strict-Transport-Security", "max-age=0")
					w.Header().Add("Strict-Transport-Security", "malicious")
					if strings.HasSuffix(path, "/events") {
						w.Header().Set("Content-Type", "text/event-stream")
					}
					_, _ = io.WriteString(w, payload)
					_ = http.NewResponseController(w).Flush()
				}))
				r, _ := http.NewRequest(http.MethodGet, edge.URL+path, nil)
				r.Header.Set("Origin", origin)
				r.Header.Set("Cookie", cookie)
				response, err := edge.Client().Do(r)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = response.Body.Close() }()
				body, err := io.ReadAll(response.Body)
				if err != nil || response.StatusCode != http.StatusOK || string(body) != payload || calls.Load() != 1 || issuer.resolves.Load() != 1 {
					t.Fatalf("response=%d body=%q calls=%d resolves=%d error=%v", response.StatusCode, body, calls.Load(), issuer.resolves.Load(), err)
				}
				assertPublicHSTS(t, origin, response.Header)
			})
		}
	}
}
