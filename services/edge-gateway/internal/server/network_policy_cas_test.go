package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestGatewayRetainsOnlyMatchingNetworkPolicyCASGuard(t *testing.T) {
	for _, scenario := range []struct {
		name, value string
		duplicate   bool
		status      int
	}{
		{"matches authenticated principal", url.PathEscape(`["org-1","user-admin"]`), false, 200},
		{"canonicalizes equivalent encoding", url.PathEscape(` [ "org-1" , "user-admin" ] `), false, 200},
		{"stale organization", url.PathEscape(`["org-old","user-admin"]`), false, 409},
		{"stale user", url.PathEscape(`["org-1","user-old"]`), false, 409},
		{"duplicate", url.PathEscape(`["org-1","user-admin"]`), true, 409},
		{"invalid escaping", "%GG", false, 409},
		{"missing", "", false, 409},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			called := false
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Header.Get("X-Antnest-Expected-Principal") != url.PathEscape(`["org-1","user-admin"]`) {
					t.Error("CAS guard was lost or not canonicalized")
				}
				if r.Header.Get("Antnest-Caller-Context") != "trusted-issuer-context" {
					t.Error("CAS guard replaced signed authority")
				}
				if r.Header.Get("X-Antnest-Future-Privilege") != "" {
					t.Error("browser privilege hint escaped stripping")
				}
				w.WriteHeader(200)
			}), time.Now())
			r := httptest.NewRequest("PUT", "/api/admin/agents/agent-1/network-policy", strings.NewReader("{}"))
			addSessionCookies(r, "token", "csrf-1")
			r.Header.Set("X-Antnest-CSRF-Token", "csrf-1")
			r.Header.Set("X-Antnest-Future-Privilege", "admin")
			if scenario.value != "" {
				r.Header.Set("X-Antnest-Expected-Principal", scenario.value)
			}
			if scenario.duplicate {
				r.Header.Add("X-Antnest-Expected-Principal", scenario.value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != scenario.status || called != (scenario.status == 200) {
				t.Fatalf("status=%d expected=%d called=%v", w.Code, scenario.status, called)
			}
		})
	}
}

func TestNetworkPolicyCASGuardDoesNotReachUnrelatedRoutes(t *testing.T) {
	for _, route := range []struct{ method, path string }{{"GET", "/"}, {"GET", "/api/admin/agents/agent-1/network-policy"}, {"POST", "/api/admin/agents/agent-1/rebuild"}} {
		h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Antnest-Expected-Principal") != "" {
				t.Error("CAS guard escaped its owning operation")
			}
			w.WriteHeader(200)
		}), time.Now())
		r := httptest.NewRequest(route.method, route.path, nil)
		addSessionCookies(r, "token", "csrf-1")
		r.Header.Set("X-Antnest-CSRF-Token", "csrf-1")
		r.Header.Set("X-Antnest-Expected-Principal", url.PathEscape(`["org-1","user-admin"]`))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("status=%d", w.Code)
		}
	}
}
