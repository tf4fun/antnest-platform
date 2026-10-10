package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestSessionRejectsTossedCSRFBeforeEveryAuthenticatedMutation(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodDelete, "/api/session"},
		{http.MethodPost, "/api/admin/agents"},
		{http.MethodPut, "/api/admin/agents/agent-1"},
		{http.MethodPatch, "/api/admin/agents/agent-1"},
		{http.MethodDelete, "/api/admin/agents/agent-1"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/messages"},
		{http.MethodPost, "/api/app/agents/agent-1/acp"},
		{http.MethodDelete, "/api/app/agents/agent-1/acp"},
		{http.MethodPost, "/api/app/agents/agent-1/v1/acp"},
		{http.MethodDelete, "/api/app/agents/agent-1/v1/acp"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			issuer := &identityServiceStub{resolvePrincipal: administratorPrincipal(), revokeStatus: identity.RevokeStatusRevoked}
			upstreamCalls := 0
			h := newTestHandler(t, issuer, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				upstreamCalls++
				w.WriteHeader(http.StatusNoContent)
			}), time.Now())
			r := newBrowserRequest(route.method, route.path, nil)
			addSessionCookies(r, "token-1", "attacker-supplied")
			r.Header.Set(session.CSRFHeaderName, "attacker-supplied")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"code":"csrf_failed"`) {
				t.Errorf("planted pair: status=%d body=%s", w.Code, w.Body.String())
			}
			if upstreamCalls != 0 || issuer.revokedAccessToken != "" || len(w.Result().Cookies()) != 0 {
				t.Error("rejected CSRF produced upstream, revocation or cookie effects")
			}
		})
	}
}

func TestSessionBoundCSRFRejectsReplayAndIgnoresDeliveryCookieValue(t *testing.T) {
	const secondCSRF = "JM8gOo12BSzaeT7HPA98jWao_tv2tDPbC_iyqj6JfFg"
	for _, route := range []struct{ method, path string }{
		{http.MethodDelete, "/api/session"},
		{http.MethodPost, "/api/admin/agents"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/messages"},
		{http.MethodPost, "/api/app/agents/agent-1/v1/acp"},
	} {
		for _, delivery := range []string{"", "planted", testCSRFToken} {
			for _, header := range []string{testCSRFToken, secondCSRF} {
				t.Run(route.path+"/"+delivery+"/"+header, func(t *testing.T) {
					principal := administratorPrincipal()
					principal.SessionID = "token-2"
					issuer := &identityServiceStub{resolvePrincipal: principal, revokeStatus: identity.RevokeStatusRevoked}
					calls := 0
					h := newTestHandler(t, issuer, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(204) }), time.Now())
					r := newBrowserRequest(route.method, route.path, nil)
					r.AddCookie(&http.Cookie{Name: session.AccessTokenCookieName, Value: "second-private-token"})
					if delivery != "" {
						r.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: delivery})
					}
					r.Header.Set(session.CSRFHeaderName, header)
					r.Header.Set("X-Antnest-Session-ID", "token-1")
					w := httptest.NewRecorder()
					h.ServeHTTP(w, r)
					if header == testCSRFToken {
						if w.Code != 403 || !strings.Contains(w.Body.String(), `"code":"csrf_failed"`) || calls != 0 || issuer.revokedAccessToken != "" || len(w.Result().Cookies()) != 0 {
							t.Fatalf("cross-session replay: %d %s", w.Code, w.Body.String())
						}
					} else {
						if w.Code != 204 {
							t.Fatalf("bound header rejected: %d %s", w.Code, w.Body.String())
						}
						if route.path == "/api/session" {
							if issuer.revokedAccessToken != "second-private-token" || calls != 0 {
								t.Fatal("logout did not revoke the resolved credential")
							}
						} else if calls != 1 {
							t.Fatal("valid request did not reach owning service")
						}
					}
				})
			}
		}
	}
}

func TestLogoutResolvesBoundSessionAndPreservesRetryableCredentials(t *testing.T) {
	const cookie = "antnest_session=token-1; antnest_csrf=delivery"
	for _, row := range []struct {
		name, cookie, header, origin, sid, code string
		resolveErr, revokeErr                   error
		inactive                                bool
		revokeStatus                            identity.RevokeStatus
		status, resolves, revokes, clears       int
	}{
		{name: "no cookies", status: 204, clears: 2},
		{name: "delivery only", cookie: "antnest_csrf=delivery", status: 204, clears: 2},
		{name: "empty session", cookie: "antnest_session=", status: 401, code: "unauthenticated", clears: 2},
		{name: "duplicate session", cookie: cookie + "; antnest_session=token-1", status: 401, code: "unauthenticated", clears: 2},
		{name: "duplicate delivery", cookie: cookie + "; antnest_csrf=delivery", status: 401, code: "unauthenticated", clears: 2},
		{name: "malformed delivery", cookie: cookie + "; antnest_csrf=bad\\value", status: 401, code: "unauthenticated", clears: 2},
		{name: "expired", cookie: cookie, resolveErr: &identity.RemoteError{Code: "unauthenticated", StatusCode: 401}, status: 401, code: "unauthenticated", resolves: 1, clears: 2},
		{name: "inactive error", cookie: cookie, resolveErr: &identity.RemoteError{Code: "inactive_principal", StatusCode: 401}, status: 401, code: "unauthenticated", resolves: 1, clears: 2},
		{name: "inactive principal", cookie: cookie, inactive: true, status: 401, code: "unauthenticated", resolves: 1, clears: 2},
		{name: "resolve timeout", cookie: cookie, resolveErr: context.DeadlineExceeded, status: 503, code: "identity_unavailable", resolves: 1},
		{name: "missing trusted sid", cookie: cookie, sid: "missing", status: 503, code: "identity_unavailable", resolves: 1},
		{name: "no header", cookie: cookie, status: 403, code: "csrf_failed", resolves: 1},
		{name: "planted pair", cookie: cookie, header: "delivery", status: 403, code: "csrf_failed", resolves: 1},
		{name: "revoke timeout", cookie: cookie, header: testCSRFToken, revokeErr: context.DeadlineExceeded, status: 503, code: "identity_unavailable", resolves: 1, revokes: 1},
		{name: "revoked", cookie: cookie, header: testCSRFToken, revokeStatus: identity.RevokeStatusRevoked, status: 204, resolves: 1, revokes: 1, clears: 2},
		{name: "already invalid", cookie: cookie, header: testCSRFToken, revokeStatus: identity.RevokeStatusAlreadyInvalid, status: 204, resolves: 1, revokes: 1, clears: 2},
		{name: "no delivery cookie", cookie: "antnest_session=token-1", header: testCSRFToken, revokeStatus: identity.RevokeStatusRevoked, status: 204, resolves: 1, revokes: 1, clears: 2},
		{name: "foreign origin first", cookie: cookie, header: testCSRFToken, origin: "https://foreign.example", status: 403, code: "forbidden"},
	} {
		t.Run(row.name, func(t *testing.T) {
			principal := administratorPrincipal()
			principal.Active = !row.inactive
			if row.sid == "missing" {
				principal.SessionID = ""
			}
			issuer := &originIdentity{identityServiceStub: identityServiceStub{resolvePrincipal: principal, resolveErr: row.resolveErr, revokeErr: row.revokeErr, revokeStatus: row.revokeStatus}}
			h := newTestHandler(t, issuer, http.NotFoundHandler(), time.Now())
			r := newBrowserRequest(http.MethodDelete, "/api/session", nil)
			r.Header.Set("Cookie", row.cookie)
			if row.header != "" {
				r.Header.Set(session.CSRFHeaderName, row.header)
			}
			if row.origin != "" {
				r.Header.Set("Origin", row.origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != row.status || (row.code != "" && !strings.Contains(w.Body.String(), `"code":"`+row.code+`"`)) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			revokes := 0
			if issuer.revokedAccessToken != "" {
				revokes = 1
			}
			if issuer.resolveCalls != row.resolves || revokes != row.revokes || len(w.Result().Cookies()) != row.clears {
				t.Fatalf("effects: resolves=%d revokes=%d cookies=%d", issuer.resolveCalls, revokes, len(w.Result().Cookies()))
			}
			for _, c := range w.Result().Cookies() {
				if c.MaxAge >= 0 || c.Value != "" {
					t.Fatal("invalid session retained a cookie")
				}
			}
		})
	}
}
