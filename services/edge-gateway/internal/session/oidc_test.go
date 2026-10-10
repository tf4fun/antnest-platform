package session

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOIDCBrowserBindingPolicy(t *testing.T) {
	for _, secure := range []bool{false, true} {
		now := time.Now()
		manager, err := NewManager(Config{CSRFKey: []byte(testCSRFKey), Secure: secure, Now: func() time.Time { return now }})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		if err := manager.BindOIDC(response, "https://idp.test/authorize?state=opaque-state", now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		cookies := response.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("missing pending OIDC cookie")
		}
		cookie := cookies[0]
		if cookie.Secure != secure || !cookie.HttpOnly || cookie.Domain != "" || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode || cookie.Value == "opaque-state" {
			t.Fatal("invalid OIDC cookie policy")
		}
		if secure && cookie.Name != "__Host-antnest_oidc" {
			t.Fatal("secure cookie is not host-prefixed")
		}
		request := httptest.NewRequest(http.MethodGet, "/protocol/oidc/callback", nil)
		request.AddCookie(cookie)
		if !manager.MatchesOIDC(request, "opaque-state") || manager.MatchesOIDC(request, "different-state") {
			t.Fatal("incorrect state binding")
		}
		request.AddCookie(cookie)
		if manager.MatchesOIDC(request, "opaque-state") {
			t.Fatal("ambiguous duplicate cookies accepted")
		}
		cleared := httptest.NewRecorder()
		manager.ClearOIDC(cleared)
		removed := cleared.Result().Cookies()[0]
		if removed.Name != cookie.Name || removed.Value != "" || removed.MaxAge >= 0 || removed.Secure != secure {
			t.Fatal("OIDC binding was not cleared")
		}
	}
}

func TestOIDCBrowserBindingRejectsInvalidStart(t *testing.T) {
	now := time.Now()
	manager, err := NewManager(Config{CSRFKey: []byte(testCSRFKey), Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/relative", "file://idp/authorize?state=a", "https://idp/authorize", "https://idp/authorize?state=a&state=b", "https://idp/authorize?state=a&bad=%ZZ"} {
		response := httptest.NewRecorder()
		if manager.BindOIDC(response, target, now.Add(time.Minute)) == nil || len(response.Result().Cookies()) != 0 {
			t.Fatal("invalid transaction accepted")
		}
	}
	if manager.BindOIDC(httptest.NewRecorder(), "https://idp/authorize?state=a", now) == nil {
		t.Fatal("expired transaction accepted")
	}
}
