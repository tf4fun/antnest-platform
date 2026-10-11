package oidcclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestSignedIDTokenRejectsInvalidRawSubject(t *testing.T) {
	for _, subject := range []any{
		json.RawMessage(`"\ud800"`), json.RawMessage(`"\udc00"`), json.RawMessage(`"x\ud800y"`),
		"\x00", "x\x00y", "", strings.Repeat("🙂", 256),
	} {
		t.Run(string(mustJSON(t, subject)), func(t *testing.T) {
			provider := newFakeProviderClaims(t, "nonce-1", "subject-1", map[string]any{"sub": subject})
			defer provider.Close()
			client, err := New(provider.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ExchangeAndVerify(t.Context(), signedSubjectInput(provider.URL))
			if err == nil {
				t.Fatal("verified JWT admitted an invalid raw subject")
			}
		})
	}
}

func TestSignedIDTokenOptionalClaimsDoNotInvalidateVerifiedSubject(t *testing.T) {
	for _, test := range []struct {
		name     string
		claims   map[string]any
		email    string
		verified bool
		display  string
	}{
		{name: "email_wrong_type", claims: map[string]any{"email": 42}, verified: true, display: "Alice"},
		{name: "verification_wrong_type", claims: map[string]any{"email_verified": "true"}, email: "alice@example.com", display: "Alice"},
		{name: "name_wrong_type", claims: map[string]any{"name": 42}, email: "alice@example.com", verified: true},
		{name: "username_wrong_type", claims: map[string]any{"name": nil, "preferred_username": []string{"Alice"}}, email: "alice@example.com", verified: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			provider := newFakeProviderClaims(t, "nonce-1", "subject-1", test.claims)
			defer provider.Close()
			client, err := New(provider.Client())
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.ExchangeAndVerify(t.Context(), signedSubjectInput(provider.URL))
			if err != nil {
				t.Fatalf("optional profile claim blocked verified subject: %v", err)
			}
			identity := result.Identity
			if identity.Issuer != provider.URL || identity.Subject != "subject-1" || identity.Email != test.email || identity.EmailVerified != test.verified || identity.DisplayName != test.display {
				t.Fatal("invalid optional claim was coerced or another verified claim was lost")
			}
		})
	}
}

func TestUserInfoOptionalProfileClaimsDoNotSupplyInvalidAuthority(t *testing.T) {
	for _, field := range []string{"name", "preferred_username", "email", "email_verified"} {
		t.Run(field, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Authorization") != "Bearer test-access" {
					t.Error("missing UserInfo authentication")
				}
				claims := map[string]any{"sub": "subject-1", "email": "alice@example.com", "email_verified": true}
				claims[field] = []string{"invalid-profile-type"}
				writeJSON(t, response, claims)
			}))
			defer server.Close()
			client, err := New(server.Client())
			if err != nil {
				t.Fatal(err)
			}
			identity, err := client.FetchUserInfo(t.Context(), oidcflow.UserInfoInput{Endpoint: server.URL, AccessToken: "test-access", Identity: oidcflow.VerifiedIdentity{Issuer: server.URL, Subject: "subject-1"}})
			if err != nil || identity.Subject != "subject-1" || identity.DisplayName != "" {
				t.Fatalf("optional UserInfo profile invalidated subject: %v", err)
			}
			if field == "email" {
				if identity.Email != "" || identity.EmailVerified {
					t.Fatal("invalid UserInfo email granted authority")
				}
			} else if identity.Email != "alice@example.com" || identity.EmailVerified != (field != "email_verified") {
				t.Fatal("optional UserInfo claim was coerced or valid email authority lost")
			}
		})
	}
}

func signedSubjectInput(issuer string) oidcflow.ExchangeInput {
	return oidcflow.ExchangeInput{
		Provider:    oidcflow.Provider{Issuer: issuer, ClientID: "client-1", TokenEndpoint: issuer + "/token", JWKSURI: issuer + "/jwks", TokenEndpointAuthMethod: "client_secret_basic", IDTokenSigningAlgs: []string{"RS256"}},
		RedirectURI: "http://localhost/callback", ClientSecret: "client-secret", Code: "code-1", Nonce: "nonce-1", PKCEVerifier: "verifier-1",
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
