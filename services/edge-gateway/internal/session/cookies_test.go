package session

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagerEstablishesReadsAndClearsSession(t *testing.T) {
	now := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)
	manager, err := NewManager(Config{
		Secure:  true,
		Now:     func() time.Time { return now },
		CSRFKey: []byte(testCSRFKey),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	recorder := httptest.NewRecorder()
	csrf, err := manager.Establish(
		recorder, "ant_api_secret", "token-1", now.Add(time.Hour),
	)
	if err != nil || csrf != testCSRFToken {
		t.Fatalf("Establish csrf=%q err=%v", csrf, err)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("cookie count=%d want=2", len(cookies))
	}
	for _, cookie := range cookies {
		if cookie.Name != "__Host-antnest_session" && cookie.Name != "__Host-antnest_csrf" {
			t.Errorf("Secure session emitted unprefixed cookie %q", cookie.Name)
		}
		if !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
			t.Errorf("cookie policy = %#v", cookie)
		}
		if cookie.Name != "__Host-antnest_csrf" && !cookie.HttpOnly {
			t.Errorf("secret cookie %s is readable by script", cookie.Name)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	values, status := manager.Read(request)
	if status != Valid || values.AccessToken != "ant_api_secret" {
		t.Fatalf("Read = %#v, %v", values, status)
	}
	request.Header.Set(CSRFHeaderName, testCSRFToken)
	if !manager.ValidCSRF(request, "token-1") {
		t.Fatal("matching CSRF token was rejected")
	}
	request.Header.Set(CSRFHeaderName, "other")
	if manager.ValidCSRF(request, "token-1") {
		t.Fatal("mismatched CSRF token was accepted")
	}

	cleared := httptest.NewRecorder()
	manager.Clear(cleared)
	for _, cookie := range cleared.Result().Cookies() {
		if cookie.MaxAge >= 0 || !cookie.Expires.Before(now) {
			t.Errorf("cookie was not expired: %#v", cookie)
		}
	}
}

func TestManagerRequiresAnExplicitCSRFKey(t *testing.T) {
	if _, err := NewManager(Config{}); err == nil {
		t.Fatal("session manager accepted a missing CSRF key")
	}
}

func TestManagerAcceptsMissingDeliveryCookieAndRejectsOversizedCookies(t *testing.T) {
	manager, err := NewManager(Config{CSRFKey: []byte(testCSRFKey)})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "token"})
	if _, status := manager.Read(request); status != Valid {
		t.Fatal("delivery cookie became an authentication requirement")
	}
	request.AddCookie(&http.Cookie{Name: CSRFCookieName, Value: strings.Repeat("a", 5000)})
	if _, status := manager.Read(request); status != Invalid {
		t.Fatal("oversized session was accepted")
	}
}
