package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestOIDCCallbackRejectsTransferredBrowserTransaction(t *testing.T) {
	for _, cookies := range []string{"", "antnest_oidc=foreign-browser"} {
		t.Run(cookies, func(t *testing.T) {
			now := time.Now()
			upstream := &identityServiceStub{completeOIDCResult: identity.OIDCCallbackResult{
				Principal: ordinaryPrincipal(), AccessToken: "must-not-be-issued", ExpiresAt: now.Add(time.Hour),
			}}
			handler := newTestHandler(t, upstream, http.NotFoundHandler(), now)
			request := newBrowserRequest(http.MethodGet, "/protocol/oidc/callback?state=valid-state&code=valid-code", nil)
			request.Header.Set("Cookie", cookies)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/?auth_error=oidc_login_failed" {
				t.Fatal("callback transferred to another browser was accepted")
			}
			if upstream.completeOIDCInput.State != "" || len(response.Result().Cookies()) != 0 {
				t.Fatal("unbound callback reached Identity or changed browser cookies")
			}
		})
	}
}

func beginTestOIDC(t *testing.T, handler http.Handler) []*http.Cookie {
	t.Helper()
	request := newBrowserRequest(http.MethodPost, "/api/session/oidc/start",
		strings.NewReader(`{"organization_slug":"engineering","provider_name":"workforce"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("OIDC start status=%d", response.Code)
	}
	return response.Result().Cookies()
}

func TestOIDCCallbackRejectsDuplicateParametersWithoutConsumingBinding(t *testing.T) {
	now := time.Now()
	upstream := &identityServiceStub{startOIDCResult: identity.StartOIDCLoginResult{
		AuthorizationURL: "https://idp.test/authorize?state=valid-state", ExpiresAt: now.Add(time.Minute),
	}}
	handler := newTestHandler(t, upstream, http.NotFoundHandler(), now)
	cookies := beginTestOIDC(t, handler)
	for _, query := range []string{"state=valid-state&state=other&code=a", "state=valid-state&code=a&code=b", "state=valid-state&error=a&error=b"} {
		request := newBrowserRequest(http.MethodGet, "/protocol/oidc/callback?"+query, nil)
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Header().Get("Location") != "/?auth_error=oidc_login_failed" || upstream.completeOIDCInput.State != "" || len(response.Result().Cookies()) != 0 {
			t.Fatal("ambiguous callback consumed the browser transaction")
		}
	}
}
