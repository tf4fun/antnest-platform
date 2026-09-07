package session

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const OIDCCookieName = "antnest_oidc"

func (manager *Manager) BindOIDC(response http.ResponseWriter, authorizationURL string, expiresAt time.Time) error {
	parsed, err := url.Parse(authorizationURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return fmt.Errorf("invalid OIDC authorization URL")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return fmt.Errorf("invalid OIDC authorization query")
	}
	states := query["state"]
	if len(states) != 1 || !validCookieValue(states[0]) || !expiresAt.After(manager.now()) {
		return fmt.Errorf("invalid OIDC browser transaction")
	}
	manager.set(response, manager.oidcCookieName(), oidcStateDigest(states[0]), expiresAt, true, 0)
	return nil
}

func (manager *Manager) MatchesOIDC(request *http.Request, state string) bool {
	cookies := request.CookiesNamed(manager.oidcCookieName())
	if len(cookies) != 1 || !validCookieValue(state) {
		return false
	}
	expected := oidcStateDigest(state)
	return subtle.ConstantTimeCompare([]byte(cookies[0].Value), []byte(expected)) == 1
}

func (manager *Manager) ClearOIDC(response http.ResponseWriter) {
	manager.set(response, manager.oidcCookieName(), "", manager.now().Add(-time.Hour), true, -1)
}

func (manager *Manager) oidcCookieName() string {
	if manager.secure {
		return "__Host-" + OIDCCookieName
	}
	return OIDCCookieName
}

func oidcStateDigest(state string) string {
	digest := sha256.Sum256([]byte(state))
	return hex.EncodeToString(digest[:])
}
