package session

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	AccessTokenCookieName = "antnest_session"
	CSRFCookieName        = "antnest_csrf"
	CSRFHeaderName        = "X-Antnest-CSRF-Token"
	maximumCookieBytes    = 4096
)

type Config struct {
	Secure  bool
	Now     func() time.Time
	NewCSRF func() (string, error)
}

type Manager struct {
	secure  bool
	now     func() time.Time
	newCSRF func() (string, error)
}

type Values struct {
	AccessToken string
	CSRFToken   string
}

func NewManager(config Config) (*Manager, error) {
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.NewCSRF == nil {
		config.NewCSRF = randomCSRF
	}
	return &Manager{secure: config.Secure, now: config.Now, newCSRF: config.NewCSRF}, nil
}

func (manager *Manager) Establish(
	response http.ResponseWriter,
	accessToken string,
	expiresAt time.Time,
) (string, error) {
	if !validCookieValue(accessToken) || !expiresAt.After(manager.now()) {
		return "", fmt.Errorf("identity session is invalid")
	}
	csrf, err := manager.newCSRF()
	if err != nil || !validCookieValue(csrf) {
		return "", fmt.Errorf("generate CSRF token")
	}
	manager.set(response, AccessTokenCookieName, accessToken, expiresAt, true, 0)
	manager.set(response, CSRFCookieName, csrf, expiresAt, false, 0)
	return csrf, nil
}

func (manager *Manager) Read(request *http.Request) (Values, bool) {
	accessToken, accessOK := readCookie(request, AccessTokenCookieName)
	csrf, csrfOK := readCookie(request, CSRFCookieName)
	values := Values{AccessToken: accessToken, CSRFToken: csrf}
	return values, accessOK && csrfOK
}

func (manager *Manager) ValidCSRF(request *http.Request, values Values) bool {
	header := request.Header.Get(CSRFHeaderName)
	if !validCookieValue(header) || !validCookieValue(values.CSRFToken) || len(header) != len(values.CSRFToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(header), []byte(values.CSRFToken)) == 1
}

func (manager *Manager) Clear(response http.ResponseWriter) {
	expires := manager.now().Add(-time.Hour)
	manager.set(response, AccessTokenCookieName, "", expires, true, -1)
	manager.set(response, CSRFCookieName, "", expires, false, -1)
}

func (manager *Manager) set(
	response http.ResponseWriter,
	name string,
	value string,
	expires time.Time,
	httpOnly bool,
	maxAge int,
) {
	http.SetCookie(response, &http.Cookie{
		Name: name, Value: value, Path: "/", Expires: expires.UTC(), MaxAge: maxAge,
		HttpOnly: httpOnly, Secure: manager.secure, SameSite: http.SameSiteLaxMode,
	})
}

func readCookie(request *http.Request, name string) (string, bool) {
	cookie, err := request.Cookie(name)
	if err != nil || !validCookieValue(cookie.Value) {
		return "", false
	}
	return cookie.Value, true
}

func validCookieValue(value string) bool {
	return value != "" && len(value) <= maximumCookieBytes && strings.TrimSpace(value) == value
}

func randomCSRF() (string, error) {
	payload := make([]byte, 32)
	if _, err := rand.Read(payload); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}
