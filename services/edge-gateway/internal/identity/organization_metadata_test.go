package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func organizationResponse(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"principal": map[string]any{
			"user_id": "user-1", "organization_id": "org-1", "membership_id": "member-1",
			"organization_slug": "engineering", "organization_name": "研发 · Équipe 🚀",
			"system_role": "user", "organization_role": "member", "active": true,
		},
		"token_id": "token-1", "access_token": "ant_api_contract_only",
		"expires_at": "2026-10-03T13:00:00Z",
	}
}

func callOrganizationClient(t *testing.T, method string, payload map[string]any) (Principal, error) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		paths := map[string]string{"login": "/rpc/identity/local-login", "resolve": "/rpc/identity/resolve-access-token", "oidc": "/protocol/oidc/callback", "oidc_replay": "/protocol/oidc/callback"}
		if request.URL.Path != paths[method] {
			t.Fatalf("unexpected Identity route %s", request.URL.Path)
		}
		return jsonResponse(http.StatusOK, string(data)), nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	switch method {
	case "login":
		result, err := client.Login(context.Background(), LoginInput{})
		return result.Principal, err
	case "resolve":
		return client.Resolve(context.Background(), "ant_api_contract_only")
	case "oidc", "oidc_replay":
		result, err := client.CompleteOIDCLogin(context.Background(), OIDCCallbackInput{State: "state", Code: "code"})
		return result.Principal, err
	default:
		t.Fatal("unknown method")
		return Principal{}, nil
	}
}

func TestOrganizationMetadataSurvivesEveryIdentityClientPath(t *testing.T) {
	for _, method := range []string{"login", "resolve", "oidc", "oidc_replay"} {
		for _, inactive := range []bool{false, true} {
			t.Run(method+map[bool]string{false: "/active", true: "/inactive"}[inactive], func(t *testing.T) {
				payload := organizationResponse(t)
				if method == "oidc_replay" {
					delete(payload, "access_token")
					payload["already_completed"] = true
				}
				payload["principal"].(map[string]any)["active"] = !inactive
				principal, err := callOrganizationClient(t, method, payload)
				if err != nil {
					t.Fatal(err)
				}
				data, err := json.Marshal(principal)
				if err != nil {
					t.Fatal(err)
				}
				var actual map[string]any
				if err := json.Unmarshal(data, &actual); err != nil {
					t.Fatal(err)
				}
				if actual["organization_slug"] != "engineering" || actual["organization_name"] != "研发 · Équipe 🚀" {
					t.Fatal("Gateway dropped Identity organization display fields")
				}
				if principal.Active == inactive || principal.Administrator() || principal.OrganizationID != "org-1" {
					t.Fatal("display metadata changed authority")
				}
			})
		}
	}
}

func TestOrganizationMetadataIsRequiredOnEveryIdentityClientPath(t *testing.T) {
	for _, method := range []string{"login", "resolve", "oidc"} {
		for _, field := range []string{"organization_slug", "organization_name"} {
			for _, invalid := range []struct {
				name  string
				value any
			}{
				{"missing", nil}, {"null", nil}, {"empty", ""}, {"whitespace", " \t\n"},
				{"unicode_whitespace", "\uFEFF\u00A0\u2028"}, {"wrong_type", 42},
			} {
				t.Run(method+"/"+field+"/"+invalid.name, func(t *testing.T) {
					payload := organizationResponse(t)
					principal := payload["principal"].(map[string]any)
					if invalid.name == "missing" {
						delete(principal, field)
					} else {
						principal[field] = invalid.value
					}
					if _, err := callOrganizationClient(t, method, payload); err == nil || IsCode(err, "unauthenticated") {
						t.Fatal("malformed display metadata must fail as an unavailable Identity response")
					}
				})
			}
		}
	}
}

func TestOrganizationDisplayTextPreservesVisibleUTF8WithoutTrimming(t *testing.T) {
	for _, method := range []string{"login", "resolve", "oidc", "oidc_replay"} {
		t.Run(method, func(t *testing.T) {
			payload := organizationResponse(t)
			name := "\uFEFF 研发 · Équipe 🚀 "
			payload["principal"].(map[string]any)["organization_name"] = name
			principal, err := callOrganizationClient(t, method, payload)
			if err != nil {
				t.Fatal(err)
			}
			if principal.OrganizationName != name {
				t.Fatal("display validation must preserve Identity's exact UTF-8 text")
			}
		})
	}
}
