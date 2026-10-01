package oidcclient

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestClientDiscoversBuildsPKCEAndVerifiesSignedIdentity(t *testing.T) {
	provider := newFakeProvider(t, "nonce-1", "subject-1")
	defer provider.Close()
	client, err := New(provider.Client())
	if err != nil {
		t.Fatal(err)
	}
	discovery, err := client.Discover(t.Context(), provider.URL)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(discovery.TokenEndpointAuthMethods) != 1 ||
		discovery.TokenEndpointAuthMethods[0] != "client_secret_basic" ||
		len(discovery.IDTokenSigningAlgs) != 1 || discovery.IDTokenSigningAlgs[0] != "RS256" {
		t.Fatalf("discovery security metadata = %#v", discovery)
	}
	config := oidcflow.Provider{
		Issuer: discovery.Issuer, ClientID: "client-1",
		Scopes: []string{"openid", "email"}, AuthorizationEndpoint: discovery.AuthorizationEndpoint,
		TokenEndpoint: discovery.TokenEndpoint, UserInfoEndpoint: discovery.UserInfoEndpoint,
		JWKSURI: discovery.JWKSURI, TokenEndpointAuthMethod: "client_secret_basic",
		IDTokenSigningAlgs: discovery.IDTokenSigningAlgs,
	}
	authorizationURL, err := client.AuthorizationURL(oidcflow.AuthorizationInput{
		Provider: config, RedirectURI: "http://localhost/callback",
		State: "state-1", Nonce: "nonce-1", PKCEChallenge: "challenge-1",
	})
	if err != nil {
		t.Fatalf("authorization URL: %v", err)
	}
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("code_challenge_method") != "S256" ||
		parsed.Query().Get("nonce") != "nonce-1" || parsed.Query().Get("state") != "state-1" {
		t.Fatalf("authorization query = %v", parsed.Query())
	}
	identity, err := client.ExchangeAndVerify(t.Context(), oidcflow.ExchangeInput{
		Provider: config, RedirectURI: "http://localhost/callback",
		ClientSecret: "client-secret", Code: "code-1",
		Nonce: "nonce-1", PKCEVerifier: "verifier-1",
	})
	if err != nil {
		t.Fatalf("exchange and verify: %v", err)
	}
	if identity.Subject != "subject-1" || identity.Email != "alice@example.com" || !identity.EmailVerified {
		t.Fatalf("identity = %#v", identity)
	}
}

func TestExchangeUsesOneConfiguredClientAuthenticationAttempt(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		if _, _, ok := request.BasicAuth(); !ok {
			t.Error("token request did not use client_secret_basic")
		}
		http.Error(response, "rejected", http.StatusUnauthorized)
	}))
	defer server.Close()
	client, err := New(server.Client())
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.ExchangeAndVerify(t.Context(), oidcflow.ExchangeInput{
		Provider: oidcflow.Provider{
			Issuer: server.URL, ClientID: "client", TokenEndpoint: server.URL,
			TokenEndpointAuthMethod: "client_secret_basic", IDTokenSigningAlgs: []string{"RS256"},
		},
		RedirectURI: "http://localhost/callback", ClientSecret: "secret", Code: "code",
		Nonce: "nonce", PKCEVerifier: "verifier",
	})
	if err == nil {
		t.Fatal("rejected token exchange succeeded")
	}
	if calls != 1 {
		t.Fatalf("token endpoint calls = %d, want exactly one", calls)
	}
}

func TestClientBoundsDiscoveryResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"issuer":"` + strings.Repeat("x", responseLimit) + `"}`))
	}))
	defer server.Close()
	client, err := New(server.Client())
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.Discover(t.Context(), server.URL)
	if !errors.Is(err, errResponseTooLarge) {
		t.Fatalf("oversized discovery error = %v, want response-too-large", err)
	}
}

func TestClientDoesNotFollowDiscoveryRedirects(t *testing.T) {
	redirectedCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		redirectedCalls++
		writeJSON(t, response, map[string]any{"issuer": "https://unexpected.example.com"})
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, target.URL, http.StatusFound)
	}))
	defer redirector.Close()
	client, err := New(redirector.Client())
	if err != nil {
		t.Fatal(err)
	}

	if _, err := client.Discover(t.Context(), redirector.URL); err == nil {
		t.Fatal("redirected OIDC discovery succeeded")
	}
	if redirectedCalls != 0 {
		t.Fatalf("redirect target calls = %d, want 0", redirectedCalls)
	}
}

func TestClientRejectsNonceMismatch(t *testing.T) {
	provider := newFakeProvider(t, "other-nonce", "subject-1")
	defer provider.Close()
	client, err := New(provider.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ExchangeAndVerify(t.Context(), oidcflow.ExchangeInput{
		Provider: oidcflow.Provider{
			Issuer: provider.URL, ClientID: "client-1",
			TokenEndpoint: provider.URL + "/token", UserInfoEndpoint: provider.URL + "/userinfo",
			JWKSURI: provider.URL + "/jwks", TokenEndpointAuthMethod: "client_secret_basic",
			IDTokenSigningAlgs: []string{"RS256"},
		},
		RedirectURI:  "http://localhost/callback",
		ClientSecret: "client-secret", Code: "code-1", Nonce: "nonce-1", PKCEVerifier: "verifier-1",
	})
	if err == nil {
		t.Fatal("invalid provider identity was accepted")
	}
}

func TestUserInfoRejectsSubjectMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(t, response, map[string]any{"sub": "other-subject", "email": "alice@example.com", "email_verified": true})
	}))
	defer server.Close()
	client, err := New(server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.mergeUserInfo(t.Context(), server.URL, "access-token", oidcflow.VerifiedIdentity{Subject: "subject-1"})
	if err == nil {
		t.Fatal("UserInfo subject mismatch was accepted")
	}
}

func TestUserInfoCannotReplaceVerifiedEmailWithoutItsOwnVerificationClaim(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer access-token" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		writeJSON(t, response, map[string]any{
			"sub": "subject-1", "email": "replacement@example.com", "name": "Alice",
		})
	}))
	defer server.Close()
	client, err := New(server.Client())
	if err != nil {
		t.Fatal(err)
	}

	identity, err := client.mergeUserInfo(t.Context(), server.URL, "access-token", oidcflow.VerifiedIdentity{
		Subject: "subject-1", Email: "original@example.com", EmailVerified: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if identity.Email != "replacement@example.com" || identity.EmailVerified {
		t.Fatalf("identity = %#v", identity)
	}
}

func newFakeProvider(t *testing.T, tokenNonce, userInfoSubject string) *httptest.Server {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var server *httptest.Server
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			writeJSON(t, response, map[string]any{
				"issuer": server.URL, "authorization_endpoint": server.URL + "/authorize",
				"token_endpoint": server.URL + "/token", "userinfo_endpoint": server.URL + "/userinfo",
				"jwks_uri":                              server.URL + "/jwks",
				"token_endpoint_auth_methods_supported": []string{"client_secret_basic"},
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/token":
			clientID, clientSecret, ok := request.BasicAuth()
			if !ok || clientID != "client-1" || clientSecret != "client-secret" {
				t.Errorf("token endpoint basic auth = %q, %q, %v", clientID, clientSecret, ok)
			}
			if err := request.ParseForm(); err != nil {
				t.Errorf("parse token form: %v", err)
			}
			if request.Form.Get("code_verifier") != "verifier-1" || request.Form.Get("code") != "code-1" {
				t.Errorf("token form = %v", request.Form)
			}
			writeJSON(t, response, map[string]any{
				"access_token": "access-1", "token_type": "Bearer",
				"id_token": signIDToken(t, key, server.URL, tokenNonce),
			})
		case "/jwks":
			writeJSON(t, response, map[string]any{"keys": []map[string]any{{
				"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "test-key",
				"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
			}}})
		case "/userinfo":
			if request.Header.Get("Authorization") != "Bearer access-1" {
				t.Errorf("userinfo authorization = %q", request.Header.Get("Authorization"))
			}
			writeJSON(t, response, map[string]any{
				"sub": userInfoSubject, "email": "alice@example.com", "email_verified": true, "name": "Alice",
			})
		default:
			http.NotFound(response, request)
		}
	})
	server = httptest.NewServer(handler)
	return server
}

func signIDToken(t *testing.T, key *rsa.PrivateKey, issuer, nonce string) string {
	t.Helper()
	now := time.Now().UTC()
	header := encodeJSONSegment(t, map[string]any{"alg": "RS256", "typ": "JWT", "kid": "test-key"})
	claims := encodeJSONSegment(t, map[string]any{
		"iss": issuer, "sub": "subject-1", "aud": "client-1",
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(), "nonce": nonce,
		"email": "alice@example.com", "email_verified": true, "name": "Alice",
	})
	unsigned := header + "." + claims
	digest := crypto.SHA256.New()
	_, _ = digest.Write([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest.Sum(nil))
	if err != nil {
		t.Fatal(err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func encodeJSONSegment(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func writeJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	if err := json.NewEncoder(response).Encode(value); err != nil && !strings.Contains(err.Error(), "closed") {
		t.Errorf("encode response: %v", err)
	}
}
