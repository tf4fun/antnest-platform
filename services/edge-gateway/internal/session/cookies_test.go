package session

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestManagerEstablishesReadsAndClearsSession(t *testing.T) {
	now := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)
	manager, err := NewManager(Config{
		Secure:  true,
		Now:     func() time.Time { return now },
		NewCSRF: func() (string, error) { return "csrf-secret", nil },
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	recorder := httptest.NewRecorder()
	csrf, err := manager.Establish(
		recorder, "ant_api_secret", now.Add(time.Hour),
	)
	if err != nil || csrf != "csrf-secret" {
		t.Fatalf("Establish csrf=%q err=%v", csrf, err)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("cookie count=%d want=2", len(cookies))
	}
	for _, cookie := range cookies {
		if !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
			t.Errorf("cookie policy = %#v", cookie)
		}
		if cookie.Name != CSRFCookieName && !cookie.HttpOnly {
			t.Errorf("secret cookie %s is readable by script", cookie.Name)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	values, ok := manager.Read(request)
	if !ok || values.AccessToken != "ant_api_secret" || values.CSRFToken != "csrf-secret" {
		t.Fatalf("Read = %#v, %v", values, ok)
	}
	request.Header.Set(CSRFHeaderName, "csrf-secret")
	if !manager.ValidCSRF(request, values) {
		t.Fatal("matching CSRF token was rejected")
	}
	request.Header.Set(CSRFHeaderName, "other")
	if manager.ValidCSRF(request, values) {
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

func TestManagerRejectsIncompleteOrOversizedCookies(t *testing.T) {
	manager, err := NewManager(Config{NewCSRF: func() (string, error) { return "csrf", nil }})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: AccessTokenCookieName, Value: "token"})
	if _, ok := manager.Read(request); ok {
		t.Fatal("incomplete session was accepted")
	}
	request.AddCookie(&http.Cookie{Name: CSRFCookieName, Value: string(make([]byte, 5000))})
	if _, ok := manager.Read(request); ok {
		t.Fatal("oversized session was accepted")
	}
}
