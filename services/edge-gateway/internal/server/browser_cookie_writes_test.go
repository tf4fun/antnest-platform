package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestGatewayBrowserOrdinaryAuthenticationFailuresNeverWriteCookies(t *testing.T) {
	for _, path := range []string{"/api/session", "/api/admin/directory", "/api/app/bootstrap", "/workspace/agent-1"} {
		for _, reason := range []string{"invalid-cookie", "revoked", "inactive"} {
			t.Run(path+"/"+reason, func(t *testing.T) {
				principal := ordinaryPrincipal()
				stub := &identityServiceStub{resolvePrincipal: principal}
				if reason == "revoked" {
					stub.resolveErr = &identity.RemoteError{StatusCode: 401, Code: "unauthenticated"}
				}
				if reason == "inactive" {
					stub.resolvePrincipal.Active = false
				}
				h := newTestHandler(t, stub, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid authority reached upstream") }), time.Now())
				r := newBrowserRequest("GET", path, nil)
				addSessionCookies(r, "token", testCSRFToken)
				if reason == "invalid-cookie" {
					r.AddCookie(&http.Cookie{Name: session.AccessTokenCookieName, Value: "other-token"})
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				want := 401
				if strings.HasPrefix(path, "/workspace/") {
					want = 303
				}
				if w.Code != want || len(w.Result().Cookies()) != 0 {
					t.Fatalf("ordinary rejection: status=%d cookies=%d", w.Code, len(w.Result().Cookies()))
				}
			})
		}
	}
}

type delayedInvalidBrowserIdentity struct {
	identityServiceStub
	entered chan struct{}
	release chan struct{}
}

func (s *delayedInvalidBrowserIdentity) Resolve(ctx context.Context, _ string) (identity.Principal, error) {
	close(s.entered)
	select {
	case <-s.release:
	case <-ctx.Done():
	}
	return identity.Principal{}, &identity.RemoteError{StatusCode: 401, Code: "unauthenticated"}
}

func TestGatewayBrowserOld401CannotOverwriteNewLoginCookies(t *testing.T) {
	now := time.Now()
	stub := &delayedInvalidBrowserIdentity{entered: make(chan struct{}), release: make(chan struct{}), identityServiceStub: identityServiceStub{loginResult: identity.LoginResult{
		Principal: ordinaryPrincipal(), TokenID: "new-session-id", AccessToken: "new-private-token", ExpiresAt: now.Add(time.Hour), IdleExpiresAt: now.Add(30 * time.Minute), ActivityIntervalMS: 30000,
	}}}
	h := newTestHandler(t, stub, http.NotFoundHandler(), now)
	old := httptest.NewRecorder()
	r := newBrowserRequest("GET", "/api/session", nil)
	addSessionCookies(r, "old-private-token", testCSRFToken)
	ctx, cancel := context.WithCancel(r.Context())
	r = r.WithContext(ctx)
	done := make(chan struct{})
	var release sync.Once
	go func() { defer close(done); h.ServeHTTP(old, r) }()
	defer func() { release.Do(func() { close(stub.release) }); cancel(); <-done }()
	select {
	case <-stub.entered:
	case <-time.After(time.Second):
		t.Fatal("old request did not reach Identity")
	}
	login := newBrowserRequest("POST", "/api/session/login", strings.NewReader(`{"organization_slug":"engineering","email":"member@example.com","password":"secret"}`))
	login.Header.Set("Content-Type", "application/json")
	fresh := httptest.NewRecorder()
	h.ServeHTTP(fresh, login)
	if fresh.Code != 200 || len(fresh.Result().Cookies()) != 2 {
		t.Fatal("new login did not establish cookies")
	}
	release.Do(func() { close(stub.release) })
	<-done
	if old.Code != 401 || len(old.Result().Cookies()) != 0 {
		t.Fatal("late old authentication response overwrote the new login")
	}
}

func TestGatewayBrowserLogoutAlreadyInvalidClearsWith401(t *testing.T) {
	stub := &identityServiceStub{resolvePrincipal: ordinaryPrincipal(), revokeStatus: identity.RevokeStatusAlreadyInvalid}
	h := newTestHandler(t, stub, http.NotFoundHandler(), time.Now())
	r := newBrowserRequest("DELETE", "/api/session", nil)
	addSessionCookies(r, "token", testCSRFToken)
	r.Header.Set(session.CSRFHeaderName, testCSRFToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || len(w.Result().Cookies()) != 2 || stub.revokedAccessToken != "token" {
		t.Fatalf("invalid logout: status=%d cookies=%d", w.Code, len(w.Result().Cookies()))
	}
}

func TestBrowserConsoleProxyCannotWriteSessionCookies(t *testing.T) {
	for _, path := range []string{"/", "/api/admin/directory"} {
		t.Run(path, func(t *testing.T) {
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Add("Set-Cookie", "antnest_session=upstream; Path=/")
				w.Header().Add("Set-Cookie", "__Host-antnest_csrf=upstream; Secure; Path=/")
				w.WriteHeader(200)
			}), time.Now())
			r := newBrowserRequest("GET", path, nil)
			addSessionCookies(r, "token", testCSRFToken)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 200 || len(w.Result().Cookies()) != 0 {
				t.Fatal("ordinary Console proxy could overwrite Gateway cookies")
			}
		})
	}
}
