package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/serviceauth"
)

func TestForgedPrincipalHeadersCannotReachConsoleEffects(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"users":[],"groups":[]}`)
	h := newTestHandler(t, backend)
	r := httptest.NewRequest(http.MethodGet, "/api/admin/directory", nil)
	r.Header.Set(principal.HeaderUserID, "user-admin")
	r.Header.Set(principal.HeaderOrganizationID, "org-1")
	r.Header.Set(principal.HeaderMembershipID, "membership-1")
	r.Header.Set(principal.HeaderSystemRole, "admin")
	r.Header.Set(principal.HeaderOrganizationRole, "admin")
	w := httptest.NewRecorder()
	h.(*businessFixture).handler.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "service_unauthenticated") {
		t.Fatalf("forged header-only request was admitted: status=%d", w.Code)
	}
	if len(backend.calls) != 0 {
		t.Fatal("unauthenticated request reached a dependency")
	}
}

func TestConsoleUsesVerifiedClaimsAndRejectsContextConfusion(t *testing.T) {
	actor := principal.Principal{UserID: "real-admin", OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "user", OrganizationRole: "admin"}
	for _, scenario := range []struct {
		name, path, agent, code string
		status                  int
		change                  func(map[string]any)
	}{
		{name: "signed actor overrides spoofed hints", path: "/api/admin/directory", status: 200},
		{name: "wrong audience", path: "/api/admin/directory", status: 401, code: "caller_context_invalid", change: func(c map[string]any) { c["aud"] = []string{"agent-ui"} }},
		{name: "expired", path: "/api/admin/directory", status: 401, code: "caller_context_invalid", change: func(c map[string]any) { c["iat"] = time.Now().Unix() - 100; c["exp"] = time.Now().Unix() - 40 }},
		{name: "wrong agent", path: "/api/admin/agents/agent-1", agent: "agent-2", status: 401, code: "caller_context_invalid"},
		{name: "unscoped agent route", path: "/api/admin/agents/agent-1", status: 401, code: "caller_context_invalid"},
		{name: "unprivileged signed user", path: "/api/admin/directory", status: 403, code: "forbidden", change: func(c map[string]any) { c["org_role"] = "member" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(200, `{"users":[],"groups":[]}`)
			f := newTestHandler(t, backend).(*businessFixture)
			r := httptest.NewRequest("GET", scenario.path, nil)
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
			r.Header.Set(callercontext.Header, f.sign(actor, scenario.agent, scenario.change))
			r.Header.Set(principal.HeaderUserID, "spoof-admin")
			r.Header.Set(principal.HeaderOrganizationID, "org-evil")
			r.Header.Set(principal.HeaderSystemRole, "admin")
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != scenario.status || scenario.code != "" && !strings.Contains(w.Body.String(), scenario.code) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if scenario.status != 200 {
				if len(backend.calls) != 0 {
					t.Fatal("rejected context reached dependency")
				}
				return
			}
			if len(backend.calls) != 1 || !strings.Contains(string(backend.calls[0].Body), `"actor_principal_id":"real-admin"`) || strings.Contains(string(backend.calls[0].Body), "org-evil") {
				t.Fatal("presentation headers replaced verified actor")
			}
		})
	}
}

func TestConsoleJSONBoundaryRejectsAmbiguousInputsBeforeEffects(t *testing.T) {
	for _, scenario := range []struct {
		name, media, body string
		duplicateMedia    bool
		status            int
	}{
		{"valid UTF-8", "application/json; charset=utf-8", `{"current_password":"old-password","new_password":"abcdefghijkl"}`, false, 200},
		{"foreign charset", "application/json; charset=iso-8859-1", `{}`, false, 415},
		{"extra parameter", "application/json; profile=other", `{}`, false, 415},
		{"multiple headers", "application/json", `{}`, true, 415},
		{"duplicate member", "application/json", `{"current_password":"old-password","new_password":"abcdefghijkl","new_password":"bad-password-value"}`, false, 400},
		{"case alias", "application/json", `{"current_password":"old-password","New_Password":"abcdefghijkl"}`, false, 400},
		{"two documents", "application/json", `{} {}`, false, 400},
		{"null object", "application/json", `null`, false, 400},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(200, `{"status":"changed"}`)
			h := newTestHandler(t, backend)
			r := httptest.NewRequest("POST", "/api/admin/account/password", strings.NewReader(scenario.body))
			r.Header.Set("Idempotency-Key", "password-update-key-0001")
			r.Header.Set("Content-Type", scenario.media)
			if scenario.duplicateMedia {
				r.Header.Add("Content-Type", scenario.media)
			}
			r.Header.Set(principal.HeaderUserID, "user-admin")
			r.Header.Set(principal.HeaderOrganizationID, "org-1")
			r.Header.Set(principal.HeaderMembershipID, "membership-1")
			r.Header.Set(principal.HeaderSystemRole, "admin")
			r.Header.Set(principal.HeaderOrganizationRole, "admin")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != scenario.status {
				t.Fatalf("status=%d expected=%d body=%s", w.Code, scenario.status, w.Body.String())
			}
			if scenario.status != 200 && len(backend.calls) != 0 {
				t.Fatal("ambiguous JSON reached a dependency")
			}
		})
	}
}
