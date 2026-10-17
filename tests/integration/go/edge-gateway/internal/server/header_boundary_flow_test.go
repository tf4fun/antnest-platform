package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
		AdminConsoleURL: peer.URL, AgentUIURL: peer.URL, IdentityURL: peer.URL,
		RequestTimeout: time.Second,
	}, Dependencies{
		Identity: &identityServiceStub{resolvePrincipal: principal},
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
		{"POST", "/api/app/workspace/v1/agents/agent-1/commands"},
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
	expiresAt := now.Add(time.Hour)
	idleExpiresAt := now.Add(30 * time.Minute)
	issued := sessionFlowContext("token-1", now.Unix(), 1)
	observed := make(chan string, 32)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case observed <- r.URL.Path:
		default:
			t.Error("unexpected excess Identity calls")
			w.WriteHeader(500)
			return
		}
		expected := map[string][]string{}
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
			_ = json.NewEncoder(w).Encode(identity.LoginResult{Principal: ordinaryPrincipal(), TokenID: "token-1", AccessToken: "private-token", ExpiresAt: expiresAt, IdleExpiresAt: idleExpiresAt, ActivityIntervalMS: 30000})
		case "/rpc/identity/list-login-methods":
			_ = json.NewEncoder(w).Encode(map[string]any{"methods": []identity.LoginMethod{{Name: "fixture", DisplayName: "Fixture"}}})
		case "/rpc/identity/start-oidc-login":
			_ = json.NewEncoder(w).Encode(identity.StartOIDCLoginResult{AuthorizationURL: "https://issuer.example/authorize?state=bound-state", ExpiresAt: now.Add(time.Minute)})
		case "/protocol/oidc/callback":
			if r.Method != http.MethodGet || r.URL.Query().Get("state") != "bound-state" || r.URL.Query().Get("code") != "fixture-code" {
				t.Error("typed OIDC callback lost protocol parameters")
			}
			_ = json.NewEncoder(w).Encode(identity.OIDCCallbackResult{Principal: ordinaryPrincipal(), TokenID: "token-1", AccessToken: "private-token", ExpiresAt: expiresAt, IdleExpiresAt: idleExpiresAt, ActivityIntervalMS: 30000})
		case "/rpc/identity/resolve-access-token":
			_ = json.NewEncoder(w).Encode(map[string]any{"principal": ordinaryPrincipal(), "caller_context": issued, "expires_at": expiresAt, "idle_expires_at": idleExpiresAt, "activity_interval_ms": 30000})
		case "/rpc/identity/revoke-access-token":
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
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
	h := newTestHandlerWithConfig(t, issuer, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
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

type boundaryRejectionObserver struct {
	IdentityService
	rejected atomic.Int32
}

func (o *boundaryRejectionObserver) Resolve(ctx context.Context, token string) (identity.Principal, error) {
	principal, err := o.IdentityService.Resolve(ctx, token)
	if identity.IsCode(err, "unauthenticated") {
		o.rejected.Add(1)
	}
	return principal, err
}

// Identity is a real typed HTTP client here. The CCT is a trusted issuer framing
// fixture, not proof of signature verification at the Agent UI receiver.
func TestHeaderBoundaryBridgeUsesLiveIdentityAndVerifiedHTTPAuthority(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/app/workspace/v1/bootstrap"},
		{http.MethodGet, "/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1"},
		{http.MethodGet, "/api/app/workspace/v1/agents/agent-1/events"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/commands"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts"},
	} {
		t.Run(route.path, func(t *testing.T) {
			stream := strings.HasSuffix(route.path, "/events")
			principal := ordinaryPrincipal()
			principal.ActivityIntervalMS = 100
			issued := sessionFlowContext("token-1", time.Now().Unix(), 1)
			contract := readHeaderBoundaryContract(t)
			var resolves, forwards atomic.Int32
			recheckStarted, releaseRecheck, upstreamStopped := make(chan struct{}), make(chan struct{}), make(chan struct{})
			release := sync.OnceFunc(func() { close(releaseRecheck) })
			defer release()
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/rpc/identity/resolve-access-token" {
					n := resolves.Add(1)
					for _, field := range contract.Headers {
						if len(boundaryHeaderValues(r.Header, field.Name)) != 0 {
							t.Errorf("browser %s reached Identity HTTP", field.Name)
						}
					}
					for _, name := range []string{"Cookie", "Authorization", "Antnest-Future-Authority", "X-Antnest-Future-Privilege"} {
						if r.Header.Get(name) != "" {
							t.Errorf("browser %s reached Identity", name)
						}
					}
					var input map[string]any
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
						t.Error(err)
						w.WriteHeader(500)
						return
					}
					wantAgent := "agent-1"
					if strings.HasSuffix(route.path, "/bootstrap") {
						wantAgent = ""
					}
					agentMatches := input["agent_id"] == wantAgent || (wantAgent == "" && input["agent_id"] == nil)
					if input["profile"] != "workspace" || !agentMatches {
						t.Errorf("Identity scope=%v", input)
					}
					if stream && n > 1 {
						if n != 2 {
							t.Errorf("unexpected extra periodic Identity call %d", n)
							w.WriteHeader(500)
							return
						}
						close(recheckStarted)
						select {
						case <-releaseRecheck:
						case <-r.Context().Done():
							return
						}
						w.WriteHeader(http.StatusUnauthorized)
						_, _ = io.WriteString(w, `{"code":"unauthenticated","message":"Session revoked"}`)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"principal": principal, "caller_context": issued, "expires_at": principal.ExpiresAt, "idle_expires_at": principal.IdleExpiresAt, "activity_interval_ms": principal.ActivityIntervalMS})
					return
				}
				if forwards.Add(1) != 1 {
					t.Error("unexpected extra Bridge upstream request")
					w.WriteHeader(500)
					return
				}
				if r.Method != route.method || r.URL.RequestURI() != route.path {
					t.Errorf("Bridge transport changed: %s %s", r.Method, r.URL.RequestURI())
				}
				expected := map[string][]string{
					HeaderOrganizationID: {principal.OrganizationID}, HeaderPrincipalID: {principal.UserID}, HeaderUserID: {principal.UserID}, HeaderMembershipID: {principal.MembershipID}, HeaderAdministrator: {"false"},
					HeaderOrganizationSlug: {base64.RawURLEncoding.EncodeToString([]byte(principal.OrganizationSlug))}, HeaderOrganizationName: {base64.RawURLEncoding.EncodeToString([]byte(principal.OrganizationName))}, identity.CallerContextHeader: {issued},
				}
				if !strings.HasSuffix(route.path, "/bootstrap") {
					expected[HeaderAgentID] = []string{"agent-1"}
				}
				for _, field := range contract.Headers {
					if got := boundaryHeaderValues(r.Header, field.Name); !reflect.DeepEqual(got, expected[field.Name]) {
						t.Errorf("Bridge %s=%v want=%v", field.Name, got, expected[field.Name])
					}
				}
				for _, name := range []string{"Cookie", "Authorization", "Origin", "Antnest-Future-Authority", "X-Antnest-Future-Privilege", "X-Unlisted-Browser-Header", "Connection", "Upgrade", "Sec-WebSocket-Protocol"} {
					if r.Header.Get(name) != "" {
						t.Errorf("browser %s reached Bridge", name)
					}
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != `{"opaque":"payload"}` {
					t.Errorf("Bridge body=%q error=%v", body, err)
				}
				if stream {
					defer close(upstreamStopped)
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "event: reset\ndata: {}\n\n")
					if err := http.NewResponseController(w).Flush(); err != nil {
						t.Error(err)
						return
					}
					<-r.Context().Done()
					return
				}
				_, _ = io.WriteString(w, `{"opaque":"reply"}`)
			}))
			defer peer.Close()
			issuer, err := identity.NewClient(peer.URL, peer.Client())
			if err != nil {
				t.Fatal(err)
			}
			observer := &boundaryRejectionObserver{IdentityService: issuer}
			h := newNetworkBridgeTestHandler(t, observer, peer)
			h.maximumSessionStale = 500 * time.Millisecond
			gatewayStopped := make(chan struct{}, 3)
			edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer func() {
					select {
					case gatewayStopped <- struct{}{}:
					default:
						t.Error("unexpected extra Gateway request")
					}
				}()
				h.ServeHTTP(w, r)
			}))
			defer edge.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			makeRequest := func() *http.Request {
				r, _ := http.NewRequestWithContext(ctx, route.method, edge.URL+route.path, strings.NewReader(`{"opaque":"payload"}`))
				r.Header = boundaryAttackHeaders(t)
				r.Header.Set("Origin", edge.URL)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set(session.CSRFHeaderName, testCSRFToken)
				addSessionCookies(r, "private-token", testCSRFToken)
				return r
			}
			foreign := makeRequest()
			foreign.Header.Set("Origin", "https://foreign.example")
			response, err := edge.Client().Do(foreign)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusForbidden || resolves.Load() != 0 || forwards.Load() != 0 {
				t.Fatal("Origin rejection reached Identity or Bridge")
			}
			wantResolves := int32(1)
			if route.method == http.MethodPost {
				badCSRF := makeRequest()
				badCSRF.Header.Set(session.CSRFHeaderName, "forged")
				response, err = edge.Client().Do(badCSRF)
				if err != nil {
					t.Fatal(err)
				}
				body, _ := io.ReadAll(response.Body)
				_ = response.Body.Close()
				if response.StatusCode != http.StatusForbidden || !strings.Contains(string(body), `"code":"csrf_failed"`) || resolves.Load() != 1 || forwards.Load() != 0 {
					t.Fatal("CSRF rejection reached Bridge or bypassed authenticated binding")
				}
				wantResolves++
			}
			response, err = edge.Client().Do(makeRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = response.Body.Close() }()
			if response.StatusCode != http.StatusOK || len(response.Cookies()) != 0 {
				t.Fatalf("Bridge response=%d cookies=%v", response.StatusCode, response.Cookies())
			}
			if stream {
				frame := make([]byte, len("event: reset\ndata: {}\n\n"))
				if _, err := io.ReadFull(response.Body, frame); err != nil || string(frame) != "event: reset\ndata: {}\n\n" {
					t.Fatalf("SSE frame=%q err=%v", frame, err)
				}
				select {
				case <-recheckStarted:
				case <-ctx.Done():
					t.Fatal("held SSE did not perform actual Identity revalidation")
				}
				select {
				case <-upstreamStopped:
					t.Fatal("SSE ended before live Identity rejection")
				default:
				}
				release()
				_, err = io.Copy(io.Discard, response.Body)
				if (err != nil && !errors.Is(err, io.ErrUnexpectedEOF)) || ctx.Err() != nil || observer.rejected.Load() != 1 {
					t.Fatalf("SSE did not end from observed live rejection: read=%v client=%v rejected=%d", err, ctx.Err(), observer.rejected.Load())
				}
				select {
				case <-upstreamStopped:
				case <-ctx.Done():
					t.Fatal("revocation did not cancel actual upstream SSE")
				}
				wantResolves = 2
			} else {
				body, err := io.ReadAll(response.Body)
				if err != nil || string(body) != `{"opaque":"reply"}` {
					t.Fatalf("Bridge body=%q error=%v", body, err)
				}
			}
			wantRequests := 2
			if route.method == http.MethodPost {
				wantRequests++
			}
			for i := 0; i < wantRequests; i++ {
				select {
				case <-gatewayStopped:
				case <-ctx.Done():
					t.Fatal("Gateway handler did not join")
				}
			}
			if resolves.Load() != wantResolves || forwards.Load() != 1 || len(h.bridgeStreams) != 0 {
				t.Fatalf("resolves=%d forwards=%d capacity=%d", resolves.Load(), forwards.Load(), len(h.bridgeStreams))
			}
		})
	}
}
