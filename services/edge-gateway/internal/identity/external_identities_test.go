package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func externalPageFixture() map[string]any {
	return map[string]any{
		"bindings": []any{map[string]any{
			"id": "binding-2", "provider_id": "provider-1", "provider_name": "workforce", "provider_display_name": "Workforce",
			"organization_id": "other-org", "organization_slug": "other", "organization_name": "Other", "membership_id": "other-membership",
			"subject": " opaque 界 ", "method": "scim", "provider_enabled": false,
			"created_at": "2026-10-11T00:00:00Z", "bound_at": "2026-10-11T00:00:00Z", "revoked_at": nil,
		}},
		"notices": []any{map[string]any{
			"id": "notice-4", "binding_id": "old-binding", "provider_id": "old-provider", "provider_name": "historical", "provider_display_name": "Historical",
			"organization_id": "old-org", "organization_slug": "old", "organization_name": "Old", "membership_id": "old-membership",
			"subject": " opaque 界 ", "method": "admin", "created_at": "2026-10-10T00:00:00Z",
		}},
		"next_after_id": "binding-2", "next_notice_after_id": "notice-4",
	}
}

func externalJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func externalReplyClient(t *testing.T, payload string) *Client {
	t.Helper()
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(200, payload), nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestExternalIdentityClientBindsSelfAuthority(t *testing.T) {
	principal := browserCaller(t)
	for _, route := range []string{"list-external-identities", "unbind-external-identity", "acknowledge-external-identity-notices"} {
		t.Run(route, func(t *testing.T) {
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != "POST" || request.URL.Path != "/rpc/identity/"+route || request.Header.Get(CallerContextHeader) != principal.CallerContext {
					t.Fatal("lost owning RPC or original session CCT")
				}
				var body map[string]any
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				want := map[string]any{"actor_principal_id": principal.UserID}
				var result any
				switch route {
				case "list-external-identities":
					want["scope"], want["limit"], want["after_id"], want["notice_after_id"] = "self", float64(1), "binding-1", "notice-3"
					result = externalPageFixture()
				case "unbind-external-identity":
					want["scope"], want["request_id"], want["binding_id"], want["allow_lockout"] = "self", "request-1", "binding-2", true
					result = map[string]any{"revoked_count": 2, "current_revoked": true}
				default:
					want["request_id"], want["notice_ids"] = "request-1", []any{"notice-4", "notice-5"}
					result = map[string]any{"acknowledged_count": 0}
				}
				if !reflect.DeepEqual(body, want) {
					t.Fatalf("wrong authority or parameters: got=%v want=%v", body, want)
				}
				return jsonResponse(200, externalJSON(t, result)), nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			ctx := WithPrincipal(t.Context(), principal)
			switch route {
			case "list-external-identities":
				result, err := client.ListExternalIdentities(ctx, ExternalIdentityListInput{Limit: 1, AfterID: "binding-1", NoticeAfterID: "notice-3"})
				if err != nil {
					t.Fatal(err)
				}
				if externalJSON(t, result) != externalJSON(t, externalPageFixture()) {
					// Compare objects; struct field order is deliberately irrelevant.
					var decoded map[string]any
					if json.Unmarshal([]byte(externalJSON(t, result)), &decoded) != nil || !reflect.DeepEqual(decoded, externalPageFixture()) {
						t.Fatal("self inventory changed cross-organization entries, immutable notices, or opaque subjects")
					}
				}
			case "unbind-external-identity":
				result, err := client.UnbindExternalIdentity(ctx, ExternalIdentityUnbindInput{RequestID: "request-1", BindingID: "binding-2", AllowLockout: true})
				if err != nil || result.RevokedCount != 2 || !result.CurrentRevoked {
					t.Fatalf("lost committed revocation: %+v %v", result, err)
				}
			default:
				result, err := client.AcknowledgeExternalIdentityNotices(ctx, ExternalIdentityAcknowledgeInput{RequestID: "request-1", NoticeIDs: []string{"notice-4", "notice-5"}})
				if err != nil || result.AcknowledgedCount != 0 {
					t.Fatalf("idempotent acknowledgment rejected: %+v %v", result, err)
				}
			}
		})
	}
}

func TestExternalIdentityClientRejectsMalformedInventory(t *testing.T) {
	type mutation struct {
		name string
		edit func(map[string]any)
	}
	cases := []mutation{
		{"unknown_top", func(p map[string]any) { p["user_id"] = "private-user" }},
		{"binding_limit", func(p map[string]any) { p["bindings"] = append(p["bindings"].([]any), p["bindings"].([]any)[0]) }},
		{"notice_limit", func(p map[string]any) { p["notices"] = append(p["notices"].([]any), p["notices"].([]any)[0]) }},
	}
	for _, array := range []string{"bindings", "notices"} {
		for _, key := range []string{"id", "provider_id", "provider_name", "provider_display_name", "organization_id", "organization_slug", "organization_name", "membership_id", "subject", "method", "created_at"} {
			for _, null := range []bool{false, true} {
				cases = append(cases, mutation{fmt.Sprintf("%s/%s/null=%t", array, key, null), func(p map[string]any) {
					entry := p[array].([]any)[0].(map[string]any)
					if null {
						entry[key] = nil
					} else {
						delete(entry, key)
					}
				}})
			}
		}
		for _, pair := range []struct {
			key   string
			value any
		}{
			{"id", "bad:id"}, {"provider_id", "/bad"}, {"organization_id", "bad id"}, {"membership_id", "界"},
			{"provider_name", "\uFEFF"}, {"provider_display_name", " "}, {"organization_slug", "\t"}, {"organization_name", "\n"},
			{"subject", ""}, {"subject", "bad\x00subject"}, {"subject", strings.Repeat("界", 256)}, {"method", "unknown"}, {"created_at", "yesterday"},
			{"user_id", "must-not-be-projected"}, {"Subject", "case-alias"},
		} {
			cases = append(cases, mutation{fmt.Sprintf("%s/%s/%v", array, pair.key, pair.value), func(p map[string]any) { p[array].([]any)[0].(map[string]any)[pair.key] = pair.value }})
		}
		cases = append(cases,
			mutation{array + "/missing", func(p map[string]any) { delete(p, array) }},
			mutation{array + "/null", func(p map[string]any) { p[array] = nil }},
			mutation{array + "/null_entry", func(p map[string]any) { p[array] = []any{nil} }},
		)
	}
	for _, key := range []string{"provider_enabled", "bound_at", "revoked_at"} {
		cases = append(cases, mutation{key + "/missing", func(p map[string]any) { delete(p["bindings"].([]any)[0].(map[string]any), key) }})
		if key != "revoked_at" {
			cases = append(cases, mutation{key + "/null", func(p map[string]any) { p["bindings"].([]any)[0].(map[string]any)[key] = nil }})
		}
		cases = append(cases, mutation{key + "/wrong_type", func(p map[string]any) { p["bindings"].([]any)[0].(map[string]any)[key] = 2 }})
	}
	for _, key := range []string{"binding_id", "acknowledged_at", "revoked_at", "provider_enabled"} {
		cases = append(cases, mutation{"notice/" + key, func(p map[string]any) { p["notices"].([]any)[0].(map[string]any)[key] = nil }})
	}
	for _, key := range []string{"next_after_id", "next_notice_after_id"} {
		for _, value := range []any{nil, "", "bad:id", "a-before-input"} {
			cases = append(cases, mutation{fmt.Sprintf("%s/%v", key, value), func(p map[string]any) { p[key] = value }})
		}
	}
	for _, row := range cases {
		t.Run(row.name, func(t *testing.T) {
			payload := externalPageFixture()
			row.edit(payload)
			client := externalReplyClient(t, externalJSON(t, payload))
			if _, err := client.ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1, AfterID: "binding-1", NoticeAfterID: "notice-3"}); err == nil {
				t.Fatal("malformed external identity response admitted")
			}
		})
	}
}

func TestExternalIdentityClientChecksRawJSONAndPreservesSubject(t *testing.T) {
	base := externalJSON(t, externalPageFixture())
	for _, row := range []struct {
		name, raw string
		valid     bool
	}{
		{"opaque_whitespace", `" \t\n "`, true}, {"scalar_limit", externalJSON(t, strings.Repeat("界", 255)), true},
		{"surrogate_pair", `"\ud83d\ude00"`, true}, {"replacement_character", `"\ufffd"`, true}, {"literal_escape", `"\\ud800"`, true},
		{"lone_high", `"\ud800"`, false}, {"lone_low", `"\udc00"`, false}, {"high_then_text", `"\ud800x"`, false},
		{"high_then_high", `"\ud800\ud800"`, false}, {"invalid_utf8", "\"\xff\"", false},
	} {
		t.Run(row.name, func(t *testing.T) {
			payload := strings.ReplaceAll(base, `" opaque 界 "`, row.raw)
			result, err := externalReplyClient(t, payload).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1})
			if (err == nil) != row.valid {
				t.Fatalf("subject validity=%t err=%v", row.valid, err)
			}
			if row.valid {
				var want string
				_ = json.Unmarshal([]byte(row.raw), &want)
				if result.Bindings[0].Subject != want || result.Notices[0].Subject != want {
					t.Fatal("subject was normalized")
				}
			}
		})
	}
	for _, payload := range []string{
		`null`, `[]`, `{}`, base + `{}`, strings.Replace(base, `"bindings":`, `"Bindings":`, 1),
		strings.Replace(base, `"bindings":`, `"bindings":[],"bindings":`, 1),
		strings.Replace(base, `"subject":`, `"subject":"shadow","subject":`, 1),
	} {
		if _, err := externalReplyClient(t, payload).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1}); err == nil {
			t.Fatalf("noncanonical response admitted: %s", payload)
		}
	}
}

func TestExternalIdentityClientIndependentPagination(t *testing.T) {
	for _, array := range []string{"bindings", "notices"} {
		for _, empty := range []bool{false, true} {
			payload := externalPageFixture()
			if empty {
				payload[array] = []any{}
			}
			cursor := "next_after_id"
			if array == "notices" {
				cursor = "next_notice_after_id"
			}
			delete(payload, cursor)
			if _, err := externalReplyClient(t, externalJSON(t, payload)).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1}); err != nil {
				t.Fatal(err)
			}
		}
		for _, ids := range [][]string{{"a", "a"}, {"b", "a"}, {"before", "z"}} {
			payload := externalPageFixture()
			delete(payload, "next_after_id")
			delete(payload, "next_notice_after_id")
			var second map[string]any
			_ = json.Unmarshal([]byte(externalJSON(t, payload[array].([]any)[0])), &second)
			payload[array].([]any)[0].(map[string]any)["id"], second["id"] = ids[0], ids[1]
			payload[array] = append(payload[array].([]any), second)
			input := ExternalIdentityListInput{Limit: 2}
			if ids[0] == "before" {
				if array == "bindings" {
					input.AfterID = "before"
				} else {
					input.NoticeAfterID = "before"
				}
			}
			if _, err := externalReplyClient(t, externalJSON(t, payload)).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), input); err == nil {
				t.Fatal("nonadvancing inventory admitted")
			}
		}
	}
	for _, empty := range []bool{false, true} {
		payload := externalPageFixture()
		payload["next_after_id"], payload["next_notice_after_id"] = "z-binding", "z-notice"
		if empty {
			payload["bindings"], payload["notices"] = []any{}, []any{}
		}
		if _, err := externalReplyClient(t, externalJSON(t, payload)).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 2}); err != nil {
			t.Fatalf("advancing independent cursors rejected: %v", err)
		}
	}
}

func TestExternalIdentityClientRejectsMalformedMutationResults(t *testing.T) {
	ctx := WithPrincipal(t.Context(), browserCaller(t))
	for _, raw := range []string{`{}`, `null`, `{"revoked_count":0}`, `{"current_revoked":false}`, `{"revoked_count":null,"current_revoked":false}`, `{"revoked_count":1,"current_revoked":null}`, `{"revoked_count":-1,"current_revoked":false}`, `{"revoked_count":0,"current_revoked":true}`, `{"revoked_count":1,"current_revoked":true,"token_id":"secret"}`, `{"revoked_count":1,"revoked_count":2,"current_revoked":true}`} {
		if _, err := externalReplyClient(t, raw).UnbindExternalIdentity(ctx, ExternalIdentityUnbindInput{RequestID: "request-1", BindingID: "binding-2"}); err == nil {
			t.Fatalf("malformed unbind admitted: %s", raw)
		}
	}
	for _, raw := range []string{`{}`, `null`, `{"acknowledged_count":null}`, `{"acknowledged_count":-1}`, `{"acknowledged_count":2}`, `{"acknowledged_count":101}`, `{"acknowledged_count":1,"user_id":"private"}`, `{"acknowledged_count":0,"acknowledged_count":1}`} {
		if _, err := externalReplyClient(t, raw).AcknowledgeExternalIdentityNotices(ctx, ExternalIdentityAcknowledgeInput{RequestID: "request-1", NoticeIDs: []string{"notice-4"}}); err == nil {
			t.Fatalf("malformed acknowledgment admitted: %s", raw)
		}
	}
}

func TestExternalIdentityClientRejectsMissingAuthorityAndInvalidInputs(t *testing.T) {
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input or missing authority reached Identity")
		return nil, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	for _, ctx := range []context.Context{t.Context(), WithPrincipal(t.Context(), Principal{})} {
		if _, err := client.ListExternalIdentities(ctx, ExternalIdentityListInput{Limit: 1}); err == nil {
			t.Fatal("missing authority admitted")
		}
		if _, err := client.UnbindExternalIdentity(ctx, ExternalIdentityUnbindInput{RequestID: "r", BindingID: "b"}); err == nil {
			t.Fatal("missing authority admitted")
		}
		if _, err := client.AcknowledgeExternalIdentityNotices(ctx, ExternalIdentityAcknowledgeInput{RequestID: "r", NoticeIDs: []string{"n"}}); err == nil {
			t.Fatal("missing authority admitted")
		}
	}
	ctx := WithPrincipal(t.Context(), browserCaller(t))
	for _, input := range []ExternalIdentityListInput{{}, {Limit: 101}, {Limit: 1, AfterID: "bad id"}, {Limit: 1, NoticeAfterID: "bad:id"}} {
		if _, err := client.ListExternalIdentities(ctx, input); err == nil {
			t.Fatal("bad pagination admitted")
		}
	}
	for _, input := range []ExternalIdentityUnbindInput{{BindingID: "b"}, {RequestID: "r"}, {RequestID: "r", BindingID: "bad id"}} {
		if _, err := client.UnbindExternalIdentity(ctx, input); err == nil {
			t.Fatal("bad unbind admitted")
		}
	}
	for _, input := range []ExternalIdentityAcknowledgeInput{{NoticeIDs: []string{"n"}}, {RequestID: "r"}, {RequestID: "r", NoticeIDs: []string{"n", "n"}}, {RequestID: "r", NoticeIDs: []string{"bad:id"}}, {RequestID: "r", NoticeIDs: make([]string, 101)}} {
		if _, err := client.AcknowledgeExternalIdentityNotices(ctx, input); err == nil {
			t.Fatal("bad acknowledgment admitted")
		}
	}
}

func TestExternalIdentityClientMatchesDisplayAndTimestampContract(t *testing.T) {
	for _, array := range []string{"bindings", "notices"} {
		for _, field := range []string{"provider_name", "provider_display_name", "organization_slug", "organization_name"} {
			t.Run(array+"/"+field+"/U0085", func(t *testing.T) {
				page := externalPageFixture()
				page[array].([]any)[0].(map[string]any)[field] = "\u0085"
				if _, err := externalReplyClient(t, externalJSON(t, page)).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1}); err != nil {
					t.Fatalf("ECMAScript non-whitespace display rejected: %v", err)
				}
			})
		}
	}
	for _, field := range []string{"created_at", "bound_at", "revoked_at"} {
		for _, value := range []string{"2026-10-11T00:00:00,123Z", "2026-10-11T1:00:00Z", "2026-10-11T00:00:00+24:00", "2026-10-11T00:00:00+01:60"} {
			t.Run(field+"/"+value, func(t *testing.T) {
				page := externalPageFixture()
				page["bindings"].([]any)[0].(map[string]any)[field] = value
				if _, err := externalReplyClient(t, externalJSON(t, page)).ListExternalIdentities(WithPrincipal(t.Context(), browserCaller(t)), ExternalIdentityListInput{Limit: 1}); err == nil {
					t.Fatal("non-RFC3339 timestamp admitted")
				}
			})
		}
	}
}

func TestExternalIdentityClientAcceptsCapacityAndTombstones(t *testing.T) {
	page := externalPageFixture()
	delete(page, "next_after_id")
	delete(page, "next_notice_after_id")
	ids := make([]string, 100)
	for _, array := range []string{"bindings", "notices"} {
		items := make([]any, 100)
		for i := range items {
			var item map[string]any
			if err := json.Unmarshal([]byte(externalJSON(t, page[array].([]any)[0])), &item); err != nil {
				t.Fatal(err)
			}
			item["id"] = fmt.Sprintf("entry-%03d", i)
			item["subject"] = strings.Repeat("😀", 255)
			if array == "bindings" {
				item["bound_at"], item["revoked_at"] = "2026-10-11T01:00:00Z", "2026-10-11T02:00:00Z"
			}
			items[i], ids[i] = item, item["id"].(string)
		}
		page[array] = items
	}
	ctx := WithPrincipal(t.Context(), browserCaller(t))
	result, err := externalReplyClient(t, externalJSON(t, page)).ListExternalIdentities(ctx, ExternalIdentityListInput{Limit: 100})
	if err != nil || len(result.Bindings) != 100 || len(result.Notices) != 100 {
		t.Fatalf("full independent pages rejected: %v", err)
	}
	var decoded map[string]any
	if json.Unmarshal([]byte(externalJSON(t, result)), &decoded) != nil || !reflect.DeepEqual(decoded, page) {
		t.Fatal("tombstones or immutable snapshots changed")
	}
	ack, err := externalReplyClient(t, `{"acknowledged_count":100}`).AcknowledgeExternalIdentityNotices(ctx, ExternalIdentityAcknowledgeInput{RequestID: "r", NoticeIDs: ids})
	if err != nil || ack.AcknowledgedCount != 100 {
		t.Fatalf("100-ID acknowledgment rejected: %v", err)
	}
	zero, err := externalReplyClient(t, `{"revoked_count":0,"current_revoked":false}`).UnbindExternalIdentity(ctx, ExternalIdentityUnbindInput{RequestID: "r", BindingID: "b"})
	if err != nil || zero.RevokedCount != 0 || zero.CurrentRevoked {
		t.Fatalf("idempotent unbind rejected: %v", err)
	}
}
