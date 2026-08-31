package oidcclient

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/oidcflow"
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
	config := oidcflow.Provider{
		Issuer: discovery.Issuer, ClientID: "client-1", RedirectURI: "http://localhost/callback",
		Scopes: []string{"openid", "email"}, AuthorizationEndpoint: discovery.AuthorizationEndpoint,
		TokenEndpoint: discovery.TokenEndpoint, UserInfoEndpoint: discovery.UserInfoEndpoint,
		JWKSURI: discovery.JWKSURI,
	}
	authorizationURL, err := client.AuthorizationURL(oidcflow.AuthorizationInput{
		Provider: config, State: "state-1", Nonce: "nonce-1", PKCEChallenge: "challenge-1",
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
		Provider: config, ClientSecret: "client-secret", Code: "code-1",
		Nonce: "nonce-1", PKCEVerifier: "verifier-1",
	})
	if err != nil {
		t.Fatalf("exchange and verify: %v", err)
	}
	if identity.Subject != "subject-1" || identity.Email != "alice@example.com" || !identity.EmailVerified {
		t.Fatalf("identity = %#v", identity)
	}
}

func TestClientRejectsNonceAndUserInfoSubjectMismatch(t *testing.T) {
	tests := []struct {
		name            string
		idTokenNonce    string
		userInfoSubject string
	}{
		{name: "nonce", idTokenNonce: "other-nonce", userInfoSubject: "subject-1"},
		{name: "userinfo subject", idTokenNonce: "nonce-1", userInfoSubject: "other-subject"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := newFakeProvider(t, test.idTokenNonce, test.userInfoSubject)
			defer provider.Close()
			client, err := New(provider.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ExchangeAndVerify(t.Context(), oidcflow.ExchangeInput{
				Provider: oidcflow.Provider{
					Issuer: provider.URL, ClientID: "client-1", RedirectURI: "http://localhost/callback",
					TokenEndpoint: provider.URL + "/token", UserInfoEndpoint: provider.URL + "/userinfo",
					JWKSURI: provider.URL + "/jwks",
				},
				ClientSecret: "client-secret", Code: "code-1", Nonce: "nonce-1", PKCEVerifier: "verifier-1",
			})
			if err == nil {
				t.Fatal("invalid provider identity was accepted")
			}
		})
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
				"jwks_uri": server.URL + "/jwks",
			})
		case "/token":
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
				"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
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
