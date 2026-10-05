package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestResolveUsesExplicitProfileAndAgentAndKeepsContextPrivate(t *testing.T) {
	for _, profile := range []string{"console", "workspace", "acp"} {
		t.Run(profile, func(t *testing.T) {
			issued := testIssuerContext(t)
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				var input map[string]string
				if json.NewDecoder(r.Body).Decode(&input) != nil || input["profile"] != profile || input["agent_id"] != "agent-route" || input["access_token"] != "private-user-token" {
					t.Error("issuer scope did not match server selection")
				}
				body, _ := json.Marshal(map[string]any{"caller_context": issued, "principal": map[string]any{"user_id": "u", "organization_id": "o", "organization_slug": "org", "organization_name": "Org", "membership_id": "m", "active": true}})
				return jsonResponse(200, string(body)), nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			principal, err := client.Resolve(WithResolution(context.Background(), profile, "agent-route"), "private-user-token")
			if err != nil || principal.CallerContext != issued || principal.ContextExpiresAt.IsZero() {
				t.Fatalf("issuer context was lost: %v", err)
			}
			browser, _ := json.Marshal(principal)
			if strings.Contains(string(browser), issued) || strings.Contains(string(browser), "caller_context") {
				t.Fatal("caller context leaked to browser projection")
			}
		})
	}
}

func TestIssuerFramingRejectsNonNumericAndDuplicateDates(t *testing.T) {
	for _, claims := range []string{
		`{"iat":1,"exp":"61"}`,
		`{"iat":"1","exp":61}`,
		`{"iat":1,"exp":60,"exp":61}`,
	} {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 64))
		if _, err := issuerContextExpiration(token); err == nil {
			t.Error("ambiguous issuer dates were accepted")
		}
	}
}

func TestResolveRejectsMalformedCallerContext(t *testing.T) {
	for _, invalid := range []any{nil, "", " ", "a.b.c", "Bearer " + testIssuerContext(t), testIssuerContext(t) + "=", strings.Repeat("a", 8193)} {
		body, _ := json.Marshal(map[string]any{"caller_context": invalid, "principal": map[string]any{"user_id": "u", "organization_id": "o", "organization_slug": "org", "organization_name": "Org", "membership_id": "m", "active": true}})
		client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return jsonResponse(200, string(body)), nil })})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Resolve(context.Background(), "private-user-token"); err == nil {
			t.Fatal("malformed caller context was admitted")
		}
	}
}

func TestResolveRequiresCallerContextFromIdentity(t *testing.T) {
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"profile":"workspace"`) {
			t.Error("Identity resolution omitted the server-selected profile")
		}
		return jsonResponse(200, `{"principal":{"user_id":"u","organization_id":"o","organization_slug":"org","organization_name":"Org","membership_id":"m","system_role":"user","organization_role":"member","active":true}}`), nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Resolve(context.Background(), "private-user-token"); err == nil {
		t.Fatal("revision-13 principal-only response was admitted")
	}
}
