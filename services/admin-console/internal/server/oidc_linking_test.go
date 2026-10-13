package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const oidcProviderBaseInput = `{"name":"workforce","issuer":"https://id.example.test","client_id":"client-1","client_secret":"new-private-secret","scopes":["openid"],"enabled":true`

func oidcLinkingJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func oidcLinkingProvider() map[string]any {
	return map[string]any{
		"id": "provider-1", "organization_id": "org-1", "name": "workforce", "display_name": "Workforce",
		"issuer": "https://id.example.test", "client_id": "client-1", "client_secret": "private-response-secret",
		"scopes": []string{"openid"}, "enabled": true, "revision": 2,
		"authorization_endpoint": "https://id.example.test/authorize", "token_endpoint": "https://id.example.test/token",
		"token_endpoint_auth_method": "client_secret_basic", "id_token_signing_algs": []string{"RS256"}, "jwks_uri": "https://id.example.test/jwks",
		"created_at": "2026-10-11T00:00:00Z", "updated_at": "2026-10-11T01:00:00Z",
		"link_policy": "verified_email", "link_domains": []string{}, "authoritative": false, "link_policy_review_required": true,
	}
}

func TestOIDCLinkingProviderPolicyPreservesExplicitFalseAndOptionalSubmission(t *testing.T) {
	for _, row := range []struct {
		name, fields string
		want         map[string]any
	}{
		{"omitted", "", map[string]any{}},
		{"none_false", `,"link_policy":"none","link_domains":[],"authoritative":false`, map[string]any{"link_policy": "none", "link_domains": []any{}, "authoritative": false}},
		{"email_review_false", `,"link_policy":"verified_email","link_domains":[],"authoritative":false,"acknowledge_link_policy_review":false`, map[string]any{"link_policy": "verified_email", "link_domains": []any{}, "authoritative": false, "acknowledge_link_policy_review": false}},
		{"domains_review_true", `,"link_policy":"verified_email_in_domains","link_domains":["\uFEFF Example.COM \uFEFF"],"authoritative":true,"acknowledge_link_policy_review":true`, map[string]any{"link_policy": "verified_email_in_domains", "link_domains": []any{"example.com"}, "authoritative": true, "acknowledge_link_policy_review": true}},
	} {
		t.Run(row.name, func(t *testing.T) {
			backend := newBackendStub()
			provider := oidcLinkingProvider()
			for _, key := range []string{"link_policy", "link_domains", "authoritative"} {
				if value, ok := row.want[key]; ok {
					provider[key] = value
				}
			}
			provider["link_policy_review_required"] = row.want["acknowledge_link_policy_review"] != true
			backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"provider": provider}))
			w := requestAdmin(t, newTestHandler(t, backend), "POST", "/api/admin/provisioning/oidc-providers", oidcProviderBaseInput+row.fields+"}")
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("policy update status=%d body=%s", w.Code, w.Body.String())
			}
			call := backend.singleCall(t)
			var sent map[string]any
			decodeBytes(t, call.Body, &sent)
			if call.Path != "/rpc/identity/upsert-oidc-provider" || sent["actor_principal_id"] != "user-admin" || sent["organization_id"] != "org-1" {
				t.Fatalf("untrusted policy scope: %v", sent)
			}
			for _, key := range []string{"link_policy", "link_domains", "authoritative", "acknowledge_link_policy_review"} {
				value, exists := sent[key]
				want, required := row.want[key]
				if exists != required || !reflect.DeepEqual(value, want) {
					t.Fatalf("%s: got %v/%t want %v/%t", key, value, exists, want, required)
				}
			}
			var response struct {
				Provider map[string]any `json:"provider"`
			}
			decodeBytes(t, w.Body.Bytes(), &response)
			for _, key := range []string{"link_policy", "authoritative", "link_policy_review_required"} {
				if response.Provider[key] != provider[key] {
					t.Fatalf("lost %s: %s", key, w.Body.String())
				}
			}
			var expectedDomains any
			decodeBytes(t, []byte(oidcLinkingJSON(t, provider["link_domains"])), &expectedDomains)
			if !reflect.DeepEqual(response.Provider["link_domains"], expectedDomains) {
				t.Fatal("linking domains changed in projection")
			}
			for _, forbidden := range []string{`"client_secret"`, `"organization_id"`, `"id"`, "private-response-secret"} {
				if strings.Contains(w.Body.String(), forbidden) {
					t.Fatalf("configuration response leaked %s", forbidden)
				}
			}
		})
	}
}

func TestOIDCLinkingProviderRejectsAmbiguousOrInvalidPolicyBeforeEffects(t *testing.T) {
	for i, fields := range []string{
		`,"link_policy":"none"`, `,"link_policy":"none","link_domains":[]`, `,"acknowledge_link_policy_review":false`,
		`,"link_policy":null,"link_domains":[],"authoritative":false`, `,"link_policy":"none","link_domains":null,"authoritative":false`,
		`,"link_policy":"none","link_domains":[],"authoritative":null`, `,"link_policy":"none","link_domains":[],"authoritative":false,"acknowledge_link_policy_review":null`,
		`,"link_policy":"none","link_domains":[],"authoritative":false,"authoritative":true`, `,"link_policy":"none","link_domains":[],"Authoritative":true`,
		`,"link_policy":"unknown","link_domains":[],"authoritative":false`, `,"link_policy":"none","link_domains":["example.com"],"authoritative":false`,
		`,"link_policy":"verified_email_in_domains","link_domains":[],"authoritative":false`, `,"link_policy":"verified_email_in_domains","link_domains":[null],"authoritative":false`,
		`,"link_policy":"verified_email_in_domains","link_domains":["Example.COM","example.com"],"authoritative":false`,
		`,"link_policy":"verified_email_in_domains","link_domains":["\u0085example.com"],"authoritative":false`,
		`,"link_policy":"verified_email_in_domains","link_domains":["*.example.com"],"authoritative":false`,
		`,"link_policy":"verified_email_in_domains","link_domains":["https://example.com"],"authoritative":false`,
		`,"link_policy_review_required":false`, `,"organization_id":"other"`, `,"actor_principal_id":"forged"`,
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			backend := newBackendStub()
			w := requestAdmin(t, newTestHandler(t, backend), "POST", "/api/admin/provisioning/oidc-providers", oidcProviderBaseInput+fields+"}")
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatalf("invalid policy reached Identity: status=%d calls=%d", w.Code, len(backend.calls))
			}
		})
	}
}

func TestOIDCLinkingProviderReadAndToggleRetainReviewWarning(t *testing.T) {
	for _, toggle := range []bool{false, true} {
		backend := newBackendStub()
		provider := oidcLinkingProvider()
		provider["enabled"] = false
		method, path, body := "GET", "/api/admin/provisioning/oidc-providers", ""
		response := map[string]any{"providers": []any{provider}}
		if toggle {
			method, path, body = "POST", path+"/workforce/enabled", `{"enabled":false}`
			response = map[string]any{"provider": provider}
		}
		backend.enqueue(200, oidcLinkingJSON(t, response))
		w := requestAdmin(t, newTestHandler(t, backend), method, path, body)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"link_policy_review_required":true`) || !strings.Contains(w.Body.String(), `"authoritative":false`) {
			t.Fatalf("legacy review hidden: status=%d body=%s", w.Code, w.Body.String())
		}
		if toggle {
			var sent map[string]any
			decodeBytes(t, backend.singleCall(t).Body, &sent)
			if sent["acknowledge_link_policy_review"] != nil || sent["link_policy"] != nil {
				t.Fatal("enable toggle implicitly reviewed policy")
			}
		}
	}
}

func TestOIDCLinkingProviderRejectsIncompletePolicyResponse(t *testing.T) {
	for _, key := range []string{"link_policy", "link_domains", "authoritative", "link_policy_review_required"} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missing=%t", key, missing), func(t *testing.T) {
				provider := oidcLinkingProvider()
				if missing {
					delete(provider, key)
				} else {
					provider[key] = nil
				}
				backend := newBackendStub()
				backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"providers": []any{provider}}))
				w := requestAdmin(t, newTestHandler(t, backend), "GET", "/api/admin/provisioning/oidc-providers", "")
				if w.Code != 502 || !strings.Contains(w.Body.String(), "invalid_upstream_response") {
					t.Fatalf("incomplete policy admitted: status=%d body=%s", w.Code, w.Body.String())
				}
			})
		}
	}
}

func oidcLinkingSCIMToken(pairing any) map[string]any {
	return map[string]any{"id": "token-1", "organization_id": "org-1", "name": "Workday", "scopes": []string{"scim:read", "scim:write"}, "created_at": "2026-10-11T00:00:00Z", "oidc_provider_id": pairing,
		"expires_at": "2027-01-09T00:00:00Z", "issued_by": "user-admin", "issuer_review_required": false}
}

func TestOIDCLinkingSCIMPairingIsOptionalInputAndRequiredNullableMetadata(t *testing.T) {
	for _, pairing := range []any{nil, "provider-1"} {
		for _, issue := range []bool{false, true} {
			t.Run(fmt.Sprintf("%v/issue=%t", pairing, issue), func(t *testing.T) {
				backend := newBackendStub()
				method, body := "GET", ""
				reply := map[string]any{"tokens": []any{oidcLinkingSCIMToken(pairing)}}
				if issue {
					method = "POST"
					input := map[string]any{"name": "Workday", "scopes": []string{"scim:read", "scim:write"}}
					if pairing != nil {
						input["oidc_provider_id"] = pairing
					}
					body = oidcLinkingJSON(t, input)
					reply = map[string]any{"token": oidcLinkingSCIMToken(pairing), "credential": "one-time-private-credential"}
				}
				backend.enqueue(200, oidcLinkingJSON(t, reply))
				w := requestAdmin(t, newTestHandler(t, backend), method, "/api/admin/provisioning/scim-tokens", body)
				if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("paired token status=%d body=%s", w.Code, w.Body.String())
				}
				var projected map[string]any
				decodeBytes(t, w.Body.Bytes(), &projected)
				token := projected["token"]
				if !issue {
					token = projected["tokens"].([]any)[0]
				}
				value, exists := token.(map[string]any)["oidc_provider_id"]
				if !exists || value != pairing {
					t.Fatalf("pairing metadata lost: %s", w.Body.String())
				}
				if issue {
					var sent map[string]any
					decodeBytes(t, backend.singleCall(t).Body, &sent)
					value, exists := sent["oidc_provider_id"]
					if value != pairing || exists != (pairing != nil) {
						t.Fatalf("changed immutable grant: %v", sent)
					}
				}
			})
		}
	}
}

func TestOIDCLinkingSCIMRejectsInvalidPairingBeforeEffects(t *testing.T) {
	for _, fields := range []string{`"oidc_provider_id":"provider-1","oidc_provider_id":"provider-2"`, `"OIDC_provider_id":"provider-1"`} {
		backend := newBackendStub()
		w := requestAdmin(t, newTestHandler(t, backend), "POST", "/api/admin/provisioning/scim-tokens", `{"name":"Workday","scopes":["scim:write"],`+fields+`}`)
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatal("ambiguous SCIM pairing reached Identity")
		}
	}
	for _, raw := range []string{`null`, `""`, `"bad:id"`, `false`, `7`, `[]`, `{}`} {
		backend := newBackendStub()
		w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/provisioning/scim-tokens", `{"name":"Workday","scopes":["scim:write"],"oidc_provider_id":`+raw+`}`)
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatalf("invalid pairing reached producer: %s status=%d", raw, w.Code)
		}
	}
	for _, pairing := range []any{"", "bad:id", false} {
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"tokens": []any{oidcLinkingSCIMToken(pairing)}}))
		w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/provisioning/scim-tokens", "")
		if w.Code != 502 {
			t.Fatalf("invalid upstream pairing accepted: status=%d body=%s", w.Code, w.Body.String())
		}
	}
	backend := newBackendStub()
	token := oidcLinkingSCIMToken(nil)
	delete(token, "oidc_provider_id")
	backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"tokens": []any{token}}))
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/provisioning/scim-tokens", "")
	if w.Code != 502 {
		t.Fatalf("missing pairing silently became directory-only: status=%d", w.Code)
	}
}

func TestOIDCLinkingRejectsNoncanonicalProviderResponse(t *testing.T) {
	for _, domain := range []string{"Example.COM", " example.com ", "\uFEFFexample.com", "K.example"} {
		provider := oidcLinkingProvider()
		provider["link_policy"] = "verified_email_in_domains"
		provider["link_domains"] = []string{domain}
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"provider": provider}))
		w := requestAdmin(t, newTestHandler(t, backend), "POST", "/api/admin/provisioning/oidc-providers", oidcProviderBaseInput+"}")
		if w.Code != 502 {
			t.Fatalf("noncanonical upstream domain admitted: %q", domain)
		}
	}
}

func TestOIDCLinkingPolicyRejectsUnicodeCaseFoldingIntoASCII(t *testing.T) {
	backend := newBackendStub()
	w := requestAdmin(t, newTestHandler(t, backend), "POST", "/api/admin/provisioning/oidc-providers", oidcProviderBaseInput+`,"link_policy":"verified_email_in_domains","link_domains":["\u212A.example"],"authoritative":false}`)
	if w.Code != 400 || len(backend.calls) != 0 {
		t.Fatalf("non-ASCII domain reached Identity: status=%d calls=%d", w.Code, len(backend.calls))
	}
}

func TestOIDCLinkingRejectsAmbiguousPolicyAndPairingMetadata(t *testing.T) {
	provider := oidcLinkingJSON(t, oidcLinkingProvider())
	token := oidcLinkingJSON(t, oidcLinkingSCIMToken(nil))
	for _, row := range []struct{ path, payload string }{
		{"oidc-providers", `{"providers":[` + strings.TrimSuffix(provider, "}") + `,"Authoritative":true}]}`},
		{"oidc-providers", `{"providers":[` + strings.TrimSuffix(provider, "}") + `,"link_policy_review_required":false}]}`},
		{"oidc-providers", `{"providers":[` + strings.Replace(provider, `"link_policy_review_required":true`, `"Link_policy_review_required":true`, 1) + `]}`},
		{"scim-tokens", `{"tokens":[` + strings.TrimSuffix(token, "}") + `,"OIDC_provider_id":"provider-2"}]}`},
		{"scim-tokens", `{"tokens":[` + strings.TrimSuffix(token, "}") + `,"oidc_provider_id":"provider-2"}]}`},
		{"scim-tokens", `{"tokens":[` + strings.Replace(token, `"oidc_provider_id":null`, `"OIDC_provider_id":null`, 1) + `]}`},
	} {
		t.Run(row.payload, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(200, row.payload)
			w := requestAdmin(t, newTestHandler(t, backend), "GET", "/api/admin/provisioning/"+row.path, "")
			if w.Code != 502 {
				t.Fatalf("ambiguous metadata admitted: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
