package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const scimLifecyclePath = "/api/admin/provisioning/scim-tokens"
const scimLifecycleInput = `{"name":"Directory","scopes":["scim:read","scim:write"],"oidc_provider_id":"provider-1"`

func scimLifecycleToken() map[string]any {
	return map[string]any{
		"id": "token-1", "name": "Directory", "scopes": []string{"scim:read", "scim:write"},
		"created_at": "2026-10-11T00:00:00Z", "oidc_provider_id": "provider-1",
		"expires_at": "2027-01-09T00:00:00.000123Z", "issued_by": "user-admin", "issuer_review_required": false,
		"organization_id": "org-1", "token_hash": "private-hash-canary", "credential": "nested-private-credential",
	}
}

func scimLifecycleReply(t *testing.T, token any, issue bool) string {
	t.Helper()
	if issue {
		return oidcLinkingJSON(t, map[string]any{"token": token, "credential": "one-time-credential"})
	}
	return oidcLinkingJSON(t, map[string]any{"tokens": []any{token}, "credential": "inventory-private-credential"})
}

func TestSCIMLifecycleIssueForwardsOptionalLifetime(t *testing.T) {
	for _, ttl := range []string{"", "1", "90", "365"} {
		t.Run("days="+ttl, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusOK, scimLifecycleReply(t, scimLifecycleToken(), true))
			input := scimLifecycleInput
			if ttl != "" {
				input += `,"expires_in_days":` + ttl
			}
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, scimLifecyclePath, input+"}")
			if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("issuance status=%d body=%s", w.Code, w.Body.String())
			}
			call := backend.singleCall(t)
			var sent map[string]any
			decodeBytes(t, call.Body, &sent)
			if call.Path != "/rpc/identity/issue-scim-token" || sent["actor_principal_id"] != "user-admin" || sent["organization_id"] != "org-1" || sent["oidc_provider_id"] != "provider-1" {
				t.Fatalf("untrusted issuance scope: %v", sent)
			}
			value, exists := sent["expires_in_days"]
			if exists != (ttl != "") || exists && fmt.Sprint(value) != ttl {
				t.Fatalf("TTL forwarding got %v/%t want %s", value, exists, ttl)
			}
			for _, field := range []string{"expires_at", "issued_by", "issuer_review_required"} {
				if _, exists := sent[field]; exists {
					t.Fatalf("BFF synthesized Identity-owned %s", field)
				}
			}
		})
	}
}

func TestSCIMLifecycleRejectsInvalidInputBeforeRPC(t *testing.T) {
	for i, fields := range []string{
		`,"expires_in_days":null`, `,"expires_in_days":0`, `,"expires_in_days":-1`, `,"expires_in_days":366`,
		`,"expires_in_days":1.5`, `,"expires_in_days":"90"`, `,"expires_in_days":true`, `,"expires_in_days":[]`,
		`,"expires_in_days":90,"expires_in_days":1`, `,"Expires_In_Days":90`,
		`,"expires_at":"2099-01-01T00:00:00Z"`, `,"issued_by":"forged"`, `,"issuer_review_required":false`,
		`,"actor_principal_id":"forged"`, `,"organization_id":"other"`,
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			backend := newBackendStub()
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, scimLifecyclePath, scimLifecycleInput+fields+"}")
			if w.Code != http.StatusBadRequest || len(backend.calls) != 0 || len(w.Result().Cookies()) != 0 {
				t.Fatalf("invalid issuance status=%d calls=%d", w.Code, len(backend.calls))
			}
		})
	}
}

func TestSCIMLifecycleProjectsKnownAndLegacyMetadata(t *testing.T) {
	for _, review := range []struct {
		name     string
		issuer   any
		required bool
	}{{"known", "user-admin", false}, {"known-review", "user-admin", true}, {"legacy", nil, true}} {
		for _, issue := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/issue=%t", review.name, issue), func(t *testing.T) {
				token := scimLifecycleToken()
				token["issued_by"], token["issuer_review_required"] = review.issuer, review.required
				backend := newBackendStub()
				backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, issue))
				method, body := http.MethodGet, ""
				if issue {
					method, body = http.MethodPost, scimLifecycleInput+"}"
				}
				w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, body)
				if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
					t.Fatalf("metadata status=%d body=%s", w.Code, w.Body.String())
				}
				backend.singleCall(t)
				var response map[string]any
				decodeBytes(t, w.Body.Bytes(), &response)
				var projected map[string]any
				if issue {
					projected = response["token"].(map[string]any)
					if response["credential"] != "one-time-credential" {
						t.Fatal("issuance lost the one-time credential")
					}
				} else {
					projected = response["tokens"].([]any)[0].(map[string]any)
					if _, exists := response["credential"]; exists {
						t.Fatal("inventory leaked a credential")
					}
				}
				for _, key := range []string{"expires_at", "issued_by", "issuer_review_required", "oidc_provider_id"} {
					value, exists := projected[key]
					if !exists || !reflect.DeepEqual(value, token[key]) {
						t.Fatalf("lost lifecycle field %s: got %v/%t", key, value, exists)
					}
				}
				for _, key := range []string{"organization_id", "token_hash", "credential"} {
					if _, exists := projected[key]; exists {
						t.Fatalf("token projection exposed %s", key)
					}
				}
			})
		}
	}
}

func TestSCIMLifecycleRejectsMalformedUpstreamMetadata(t *testing.T) {
	for _, issue := range []bool{false, true} {
		for _, key := range []string{"expires_at", "issued_by", "issuer_review_required"} {
			values := []any{nil, 42, "", []any{}, map[string]any{}}
			if key == "expires_at" {
				values = append(values, "tomorrow", "2026-02-30T00:00:00Z")
			}
			if key == "issued_by" {
				values = append(values, "invalid issuer", strings.Repeat("a", 201))
			}
			for index := -1; index < len(values); index++ {
				t.Run(fmt.Sprintf("issue=%t/%s/%d", issue, key, index), func(t *testing.T) {
					token := scimLifecycleToken()
					if index < 0 {
						delete(token, key)
					} else {
						token[key] = values[index]
					}
					backend := newBackendStub()
					backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, issue))
					method, body := http.MethodGet, ""
					if issue {
						method, body = http.MethodPost, scimLifecycleInput+"}"
					}
					w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, body)
					if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "invalid_upstream_response") || strings.Contains(w.Body.String(), "credential") {
						t.Fatalf("malformed metadata admitted: status=%d body=%s", w.Code, w.Body.String())
					}
					backend.singleCall(t)
				})
			}
		}
	}
}

func TestSCIMLifecycleRejectsDuplicateAndAliasedUpstreamMetadata(t *testing.T) {
	for _, issue := range []bool{false, true} {
		for _, key := range []string{"id", "name", "scopes", "created_at", "revoked_at", "expires_at", "issued_by", "issuer_review_required"} {
			for _, alias := range []string{key, strings.ToUpper(key)} {
				t.Run(fmt.Sprintf("issue=%t/%s", issue, alias), func(t *testing.T) {
					token := scimLifecycleToken()
					token["revoked_at"] = "2026-10-12T00:00:00Z"
					value, _ := json.Marshal(token[key])
					body := strings.TrimSuffix(oidcLinkingJSON(t, token), "}") + fmt.Sprintf(",%q:%s}", alias, value)
					reply, method, input := `{"tokens":[`+body+`]}`, http.MethodGet, ""
					if issue {
						reply, method, input = `{"token":`+body+`,"credential":"one-time-credential"}`, http.MethodPost, scimLifecycleInput+"}"
					}
					backend := newBackendStub()
					backend.enqueue(http.StatusOK, reply)
					w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, input)
					if w.Code != http.StatusBadGateway {
						t.Fatalf("ambiguous upstream metadata accepted: %d", w.Code)
					}
					backend.singleCall(t)
				})
			}
		}
	}
}

func TestSCIMLifecycleDoesNotReplayAmbiguousIssuance(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusServiceUnavailable, `{"error":{"code":"unavailable","message":"Issuance unavailable"}}`)
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, scimLifecyclePath, scimLifecycleInput+"}")
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
		t.Fatalf("ambiguous issuance status=%d", w.Code)
	}
	backend.singleCall(t)
}

func TestSCIMLifecycleDatesUseContractTimestampSyntax(t *testing.T) {
	for _, row := range []struct {
		value string
		valid bool
	}{
		{"2027-01-09t00:00:00.000123z", true},
		{"2027-01-09T00:00:00+08:00", true},
		{"0001-01-01T00:00:00Z", true},
		{"2027-01-09T00:00:00,123Z", false},
		{"2027-01-09T0:00:00Z", false},
		{"2027-01-09T00:00:00+24:00", false},
		{"2027-01-09T00:00:00+00:60", false},
	} {
		for _, key := range []string{"created_at", "revoked_at", "expires_at"} {
			for _, issue := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/issue=%t", key, row.value, issue), func(t *testing.T) {
					token := scimLifecycleToken()
					token[key] = row.value
					backend := newBackendStub()
					backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, issue))
					method, body := http.MethodGet, ""
					if issue {
						method, body = http.MethodPost, scimLifecycleInput+"}"
					}
					w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, body)
					want := http.StatusBadGateway
					if row.valid {
						want = http.StatusOK
					}
					if w.Code != want || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
						t.Fatalf("expiry syntax status=%d want=%d", w.Code, want)
					}
					backend.singleCall(t)
				})
			}
		}
	}
}

func TestSCIMLifecycleRejectsMalformedBaseMetadata(t *testing.T) {
	for _, issue := range []bool{false, true} {
		for _, field := range []struct {
			key      string
			required bool
			invalid  []any
		}{
			{"id", true, []any{nil, 42, "", "invalid id", strings.Repeat("a", 201)}},
			{"name", true, []any{nil, 42, "", []any{}}},
			{"scopes", true, []any{nil, 42, "scim:read", []any{nil}, []string{"unknown"}, []string{"scim:read", ""}}},
			{"created_at", true, []any{nil, 42, "", "tomorrow", "2026-02-30T00:00:00Z"}},
			{"revoked_at", false, []any{nil, 42, "", "tomorrow", "2026-02-30T00:00:00Z"}},
		} {
			for index := -1; index < len(field.invalid); index++ {
				if index < 0 && !field.required {
					continue
				}
				t.Run(fmt.Sprintf("issue=%t/%s/%d", issue, field.key, index), func(t *testing.T) {
					token := scimLifecycleToken()
					if index < 0 {
						delete(token, field.key)
					} else {
						token[field.key] = field.invalid[index]
					}
					backend := newBackendStub()
					backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, issue))
					method, body := http.MethodGet, ""
					if issue {
						method, body = http.MethodPost, scimLifecycleInput+"}"
					}
					w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, body)
					if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "invalid_upstream_response") ||
						strings.Contains(w.Body.String(), "credential") || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
						t.Fatalf("malformed base metadata admitted: status=%d body=%s", w.Code, w.Body.String())
					}
					backend.singleCall(t)
				})
			}
		}
	}
}

func TestSCIMLifecyclePreservesValidBaseMetadata(t *testing.T) {
	for _, scopes := range [][]string{{}, {"scim:read", "scim:read"}, {"scim:write"}} {
		for _, issue := range []bool{false, true} {
			t.Run(fmt.Sprintf("scopes=%v/issue=%t", scopes, issue), func(t *testing.T) {
				token := scimLifecycleToken()
				token["id"], token["name"], token["scopes"] = strings.Repeat("a", 200), " ", scopes
				token["revoked_at"] = "2026-10-12t00:00:00.000123z"
				backend := newBackendStub()
				backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, issue))
				method, body := http.MethodGet, ""
				if issue {
					method, body = http.MethodPost, scimLifecycleInput+"}"
				}
				w := requestAdmin(t, newTestHandler(t, backend), method, scimLifecyclePath, body)
				if w.Code != http.StatusOK {
					t.Fatalf("valid base metadata rejected: status=%d body=%s", w.Code, w.Body.String())
				}
				backend.singleCall(t)
				var response map[string]json.RawMessage
				decodeBytes(t, w.Body.Bytes(), &response)
				projected := response["token"]
				if !issue {
					var tokens []json.RawMessage
					decodeBytes(t, response["tokens"], &tokens)
					projected = tokens[0]
				}
				var fields map[string]json.RawMessage
				decodeBytes(t, projected, &fields)
				for _, key := range []string{"id", "name", "scopes", "created_at", "revoked_at"} {
					expected, err := json.Marshal(token[key])
					if err != nil || string(fields[key]) != string(expected) {
						t.Fatalf("base metadata changed for %s: got %s want %s", key, fields[key], expected)
					}
				}
			})
		}
	}
}

func TestSCIMLifecycleIssuePreservesRepeatedScopes(t *testing.T) {
	backend := newBackendStub()
	token := scimLifecycleToken()
	token["scopes"] = []string{"scim:read", "scim:read"}
	backend.enqueue(http.StatusOK, scimLifecycleReply(t, token, true))
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, scimLifecyclePath,
		`{"name":"Directory","scopes":["scim:read","scim:read"],"expires_in_days":1}`)
	if w.Code != http.StatusOK {
		t.Fatalf("repeated valid scopes rejected: %d", w.Code)
	}
	var sent struct {
		Scopes []string `json:"scopes"`
	}
	decodeBytes(t, backend.singleCall(t).Body, &sent)
	if !reflect.DeepEqual(sent.Scopes, token["scopes"]) {
		t.Fatalf("repeated scopes changed: %v", sent.Scopes)
	}
}

func TestSCIMLifecycleIssuanceRequiresOneTimeCredential(t *testing.T) {
	for _, mode := range []string{"missing", "null", "empty"} {
		t.Run(mode, func(t *testing.T) {
			response := map[string]any{"token": scimLifecycleToken()}
			if mode == "null" {
				response["credential"] = nil
			}
			if mode == "empty" {
				response["credential"] = ""
			}
			backend := newBackendStub()
			backend.enqueue(http.StatusCreated, oidcLinkingJSON(t, response))
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, scimLifecyclePath, scimLifecycleInput+"}")
			if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "invalid_upstream_response") ||
				w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("unusable credential response status=%d", w.Code)
			}
			backend.singleCall(t)
		})
	}
}
