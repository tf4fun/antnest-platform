package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestBrowserCannotForwardServiceCredentialsOrFutureIdentityHeaders(t *testing.T) {
	for _, path := range []string{"/", "/api/admin/agents", "/scim/v2/Users"} {
		t.Run(path, func(t *testing.T) {
			called := false
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				for _, name := range []string{"Antnest-Service-Authorization", "X-Antnest-Future-Privilege", "X-Antnest-CSRF-Token"} {
					if len(r.Header.Values(name)) != 0 {
						t.Errorf("browser-controlled %s reached upstream", name)
					}
				}
				if r.Header.Get("Antnest-Caller-Context") == "attacker-cct" {
					t.Error("browser CCT was forwarded")
				}
				if path == "/api/admin/agents" && r.Header.Get("Antnest-Caller-Context") != "trusted-issuer-context" {
					t.Error("issuer CCT was lost")
				}
				if path == "/scim/v2/Users" && r.Header.Get("Authorization") != "Bearer scim-credential" {
					t.Error("SCIM authorization was lost")
				}
				w.WriteHeader(http.StatusOK)
			})
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, upstream, time.Now())
			r := newBrowserRequest(http.MethodGet, path, nil)
			addSessionCookies(r, "token-1", "csrf-1")
			r.Header.Set("Antnest-Service-Authorization", "Bearer attacker-service-token")
			r.Header.Set("Antnest-Caller-Context", "attacker-cct")
			r.Header.Set("X-Antnest-Future-Privilege", "admin")
			r.Header.Set("X-Antnest-CSRF-Token", "csrf-1")
			r.Header.Set("Authorization", "Bearer scim-credential")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusOK || !called {
				t.Fatalf("status=%d called=%v", w.Code, called)
			}
		})
	}
}

type selectedIdentity struct {
	identityServiceStub
	profile, agent string
}

func (s *selectedIdentity) Resolve(ctx context.Context, _ string) (identity.Principal, error) {
	s.profile, s.agent = identity.ResolutionScope(ctx)
	return s.resolvePrincipal, s.resolveErr
}

func TestGatewaySelectsCallerScopeFromActualRoute(t *testing.T) {
	for _, route := range []struct{ path, profile, agent string }{
		{"/api/session", "workspace", ""},
		{"/api/app/bootstrap", "workspace", ""},
		{"/api/admin/agents", "console", ""},
		{"/api/admin/agents/agent-1/events/watch", "console", "agent-1"},
		{"/workspace/agent-1/sessions/session-1", "workspace", ""},
		{"/api/app/workspace/v1/bootstrap", "workspace", ""},
		{"/api/app/workspace/v1/agents/agent-1/configuration", "workspace", "agent-1"},
		{"/api/app/agents/agent-1/state", "workspace", "agent-1"},
		{"/api/app/agents/agent-1/acp", "acp", "agent-1"},
	} {
		t.Run(route.path, func(t *testing.T) {
			issuer := &selectedIdentity{identityServiceStub: identityServiceStub{resolvePrincipal: administratorPrincipal()}}
			h := newTestHandler(t, issuer, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }), time.Now())
			r := newBrowserRequest("GET", route.path+"?profile=console&agent_id=forged", nil)
			// State explicitly rejects query fields before authentication.
			if route.path == "/api/app/agents/agent-1/state" {
				r.URL.RawQuery = ""
			}
			addSessionCookies(r, "token", "csrf")
			r.Header.Set(HeaderAgentID, "forged")
			r.Header.Set("Antnest-Caller-Context", "attacker")
			h.ServeHTTP(httptest.NewRecorder(), r)
			if issuer.profile != route.profile || issuer.agent != route.agent {
				t.Fatalf("profile=%s agent=%s", issuer.profile, issuer.agent)
			}
		})
	}
}

func TestGatewayCSRFIsLocalAndRejectsDuplicateFields(t *testing.T) {
	for _, duplicate := range []bool{false, true} {
		called := false
		h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			if len(r.Header.Values("X-Antnest-CSRF-Token")) != 0 {
				t.Error("CSRF credential leaked upstream")
			}
			w.WriteHeader(200)
		}), time.Now())
		r := newBrowserRequest("POST", "/api/admin/agents", nil)
		addSessionCookies(r, "token", "csrf-1")
		r.Header.Add("X-Antnest-CSRF-Token", "csrf-1")
		if duplicate {
			r.Header.Add("X-Antnest-CSRF-Token", "csrf-1")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if duplicate && (w.Code != 403 || called) || !duplicate && (w.Code != 200 || !called) {
			t.Fatalf("duplicate=%v status=%d called=%v", duplicate, w.Code, called)
		}
	}
}

func TestWebSocketCannotAdmitNewMessageAfterCallerContextExpires(t *testing.T) {
	principal := ordinaryPrincipal()
	principal.ContextExpiresAt = time.Now().Add(-time.Second)
	h := newTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, http.NotFoundHandler(), time.Now()).(*handler)
	end := h.checkRelaySession(context.Background(), "valid-user-token", principal)
	if end == nil || end.code != 1008 || end.reason != "caller_context_expired" {
		t.Fatalf("expired handshake context admitted a new message: %v", end)
	}
}
