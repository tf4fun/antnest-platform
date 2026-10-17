package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestWorkspaceBridgePreservesUpstreamRejectionAndVerifiedScope(t *testing.T) {
	for _, kind := range []string{"organization", "principal", "agent"} {
		for _, route := range []struct{ method, suffix string }{
			{http.MethodGet, "view?sessionId=session-1"},
			{http.MethodPost, "commands"},
			{http.MethodPost, "sessions/session-1/prompts"},
		} {
			t.Run(kind+"/"+route.suffix, func(t *testing.T) {
				principal := ordinaryPrincipal()
				target := "agent-1"
				switch kind {
				case "organization":
					principal.OrganizationID = "other-org"
				case "principal":
					principal.UserID = "other-user"
				case "agent":
					target = "other-agent"
				}
				path := "/api/app/workspace/v1/agents/" + target + "/" + route.suffix
				calls := 0
				const expected = `{"code":"access_denied","message":"Agent access is unavailable"}`
				upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.Method != route.method || r.URL.RequestURI() != path {
						t.Errorf("transport changed: %s %s", r.Method, r.URL.RequestURI())
					}
					for header, value := range map[string]string{
						HeaderOrganizationID: principal.OrganizationID, HeaderPrincipalID: principal.UserID,
						HeaderUserID: principal.UserID, HeaderAgentID: target, HeaderMembershipID: principal.MembershipID,
						HeaderAdministrator: "false", identity.CallerContextHeader: principal.CallerContext,
					} {
						if values := r.Header.Values(header); len(values) != 1 || values[0] != value {
							t.Errorf("verified %s=%v want %q", header, values, value)
						}
					}
					for _, header := range []string{HeaderAgentAccessSubject, "Cookie", "Authorization", "Antnest-Future-Authority", "Acp-Connection-Id", "Acp-Session-Id"} {
						if r.Header.Get(header) != "" {
							t.Errorf("browser field forwarded: %s", header)
						}
					}
					body, err := io.ReadAll(r.Body)
					if err != nil || string(body) != `{"opaque":"payload"}` {
						t.Errorf("body=%q error=%v", body, err)
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Set-Cookie", "upstream=untrusted")
					w.WriteHeader(http.StatusForbidden)
					_, _ = io.WriteString(w, expected)
				})
				h := newTestHandler(t, &identityServiceStub{resolvePrincipal: principal}, upstream, time.Now())
				r := workspaceHTTPRequest(route.method, path)
				for _, header := range []string{HeaderOrganizationID, HeaderPrincipalID, HeaderUserID, HeaderMembershipID, HeaderAgentID, HeaderAdministrator, identity.CallerContextHeader, "Antnest-Future-Authority"} {
					r.Header[http.CanonicalHeaderKey(header)] = []string{"forged", "duplicate-forged"}
				}
				r.Header.Set("Acp-Connection-Id", "retired-connection")
				r.Header.Set("Acp-Session-Id", "retired-session")
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != http.StatusForbidden || strings.TrimSpace(w.Body.String()) != expected || calls != 1 {
					t.Fatalf("response=%d %s calls=%d", w.Code, w.Body, calls)
				}
				if len(w.Result().Cookies()) != 0 || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("proxy response mutated cookies or cache policy: %v", w.Header())
				}
			})
		}
	}
}
