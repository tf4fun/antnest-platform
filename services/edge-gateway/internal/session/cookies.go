package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
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
	CSRFKey []byte
}

type Manager struct {
	secure  bool
	now     func() time.Time
	csrfKey []byte
}

type Values struct {
	AccessToken string
}

type ReadStatus uint8

const (
	Absent ReadStatus = iota
	Invalid
	Valid
)

func NewManager(config Config) (*Manager, error) {
	if config.Now == nil {
		config.Now = time.Now
	}
	if len(config.CSRFKey) != sha256.Size {
		return nil, fmt.Errorf("CSRF key must contain exactly 32 bytes")
	}
	return &Manager{secure: config.Secure, now: config.Now, csrfKey: append([]byte(nil), config.CSRFKey...)}, nil
}

func (manager *Manager) Establish(
	response http.ResponseWriter,
	accessToken string,
	tokenID string,
	expiresAt time.Time,
) (string, error) {
	if !validCookieValue(accessToken) || !callercontext.ValidID(tokenID) || !expiresAt.After(manager.now()) {
		return "", fmt.Errorf("identity session is invalid")
	}
	csrf := manager.deriveCSRF(tokenID)
	manager.set(response, manager.cookieName(AccessTokenCookieName), accessToken, expiresAt, true, 0)
	manager.set(response, manager.cookieName(CSRFCookieName), csrf, expiresAt, false, 0)
	return csrf, nil
}

func (manager *Manager) Read(request *http.Request) (Values, ReadStatus) {
	accessToken, accessStatus := readCookie(request, manager.cookieName(AccessTokenCookieName))
	_, csrfStatus := readCookie(request, manager.cookieName(CSRFCookieName))
	if accessStatus == Invalid || csrfStatus == Invalid {
		return Values{}, Invalid
	}
	return Values{AccessToken: accessToken}, accessStatus
}

func (manager *Manager) ValidCSRF(request *http.Request, tokenID string) bool {
	var headers []string
	for name, values := range request.Header {
		if strings.EqualFold(name, CSRFHeaderName) {
			headers = append(headers, values...)
		}
	}
	if len(headers) != 1 || !callercontext.ValidID(tokenID) {
		return false
	}
	expected := manager.deriveCSRF(tokenID)
	return subtle.ConstantTimeCompare([]byte(headers[0]), []byte(expected)) == 1
}

func (manager *Manager) Clear(response http.ResponseWriter) {
	expires := manager.now().Add(-time.Hour)
	manager.set(response, manager.cookieName(AccessTokenCookieName), "", expires, true, -1)
	manager.set(response, manager.cookieName(CSRFCookieName), "", expires, false, -1)
}

func (manager *Manager) cookieName(name string) string {
	if manager.secure {
		return "__Host-" + name
	}
	return name
}

func (manager *Manager) deriveCSRF(tokenID string) string {
	mac := hmac.New(sha256.New, manager.csrfKey)
	_, _ = mac.Write([]byte(tokenID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
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

func readCookie(request *http.Request, name string) (string, ReadStatus) {
	count := 0
	// Count even malformed occurrences: net/http skips those during parsing,
	// which must not turn ambiguous credentials into a first/last-wins session.
	for header, values := range request.Header {
		if !strings.EqualFold(header, "Cookie") {
			continue
		}
		for _, value := range values {
			for _, part := range strings.Split(value, ";") {
				key, _, _ := strings.Cut(strings.TrimSpace(part), "=")
				if strings.TrimSpace(key) == name {
					count++
				}
			}
		}
	}
	if count == 0 {
		return "", Absent
	}
	if count != 1 {
		return "", Invalid
	}
	cookie, err := request.Cookie(name)
	if err != nil || !validCookieValue(cookie.Value) {
		return "", Invalid
	}
	return cookie.Value, Valid
}

func validCookieValue(value string) bool {
	return value != "" && len(value) <= maximumCookieBytes && strings.TrimSpace(value) == value &&
		(&http.Cookie{Name: AccessTokenCookieName, Value: value}).Valid() == nil
}
