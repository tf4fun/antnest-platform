package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func externalIdentityControlReply(path string, body map[string]any, now time.Time) map[string]any {
	switch path {
	case "unbind-external-identity":
		return map[string]any{"revoked_count": 2, "current_revoked": body["allow_lockout"] == true}
	case "acknowledge-external-identity-notices":
		return map[string]any{"acknowledged_count": len(body["notice_ids"].([]any))}
	default:
		// Self inventory is global to the User; a notice is an immutable snapshot
		// and need not refer to a binding or Membership on the current page.
		return map[string]any{
			"bindings": []any{map[string]any{
				"id": "binding-2", "provider_id": "provider-2", "provider_name": "workforce", "provider_display_name": "Workforce",
				"organization_id": "other-org", "organization_slug": "other", "organization_name": "Other Organization", "membership_id": "other-member",
				"subject": " \t opaque 界 ", "method": "scim", "provider_enabled": false, "created_at": now, "bound_at": now, "revoked_at": nil,
			}},
			"notices": []any{map[string]any{
				"id": "notice-4", "binding_id": "historical-binding", "provider_id": "provider-old", "provider_name": "old", "provider_display_name": "Old Provider",
				"organization_id": "historical-org", "organization_slug": "historical", "organization_name": "Historical Organization", "membership_id": "old-membership",
				"subject": " \t opaque 界 ", "method": "admin", "created_at": now,
			}},
			"next_after_id": "binding-2", "next_notice_after_id": "notice-4",
		}
	}
}

func TestGatewayExternalIdentitiesUseSelfAuthorityAndPublicSchemas(t *testing.T) {
	for _, row := range []struct{ method, path, body, rpc, schema string }{
		{"GET", "/api/session/external-identities?limit=1&after_id=binding-1&notice_after_id=notice-3", "", "list-external-identities", "external_identity_list"},
		{"DELETE", "/api/session/external-identities/binding-2", `{}`, "unbind-external-identity", "external_identity_unbind_response"},
		{"DELETE", "/api/session/external-identities/binding-2", `{"allow_lockout":false}`, "unbind-external-identity", "external_identity_unbind_response"},
		{"DELETE", "/api/session/external-identities/binding-2", `{"allow_lockout":true}`, "unbind-external-identity", "external_identity_unbind_response"},
		{"POST", "/api/session/external-identities/notices/acknowledge", `{"notice_ids":["notice-4","notice-5"]}`, "acknowledge-external-identity-notices", "external_identity_acknowledge_response"},
	} {
		t.Run(row.method+row.body, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(row.method, row.path, row.body))
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("external identity response status=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(w.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := compileOrganizationSchema(t, "edge-gateway/session-response.schema.json", row.schema).Validate(value); err != nil {
				t.Fatal(err)
			}
			calls := f.calls()
			if len(calls) != 2 || calls[0].Path != "resolve-access-token" || calls[1].Path != row.rpc {
				t.Fatalf("unexpected owning calls: %+v", calls)
			}
			want := map[string]any{"actor_principal_id": f.principal.UserID}
			switch row.rpc {
			case "list-external-identities":
				want["scope"], want["limit"], want["after_id"], want["notice_after_id"] = "self", float64(1), "binding-1", "notice-3"
				var page map[string]any
				if json.Unmarshal(w.Body.Bytes(), &page) != nil || !reflect.DeepEqual(page["bindings"].([]any)[0].(map[string]any)["subject"], " \t opaque 界 ") {
					t.Fatal("opaque subject was changed")
				}
			case "unbind-external-identity":
				want["scope"], want["binding_id"], want["allow_lockout"] = "self", "binding-2", strings.Contains(row.body, "true")
				want["request_id"] = calls[1].Body["request_id"]
			case "acknowledge-external-identity-notices":
				want["notice_ids"] = []any{"notice-4", "notice-5"}
				want["request_id"] = calls[1].Body["request_id"]
			}
			if !reflect.DeepEqual(calls[1].Body, want) || row.method != "GET" && want["request_id"] == "" {
				t.Fatalf("scope or target not server derived: got=%v want=%v", calls[1].Body, want)
			}
		})
	}
}

func TestGatewayExternalIdentitiesRejectAmbiguousInputBeforeOwningRPC(t *testing.T) {
	const list = "/api/session/external-identities"
	const unbind = list + "/binding-2"
	const ack = list + "/notices/acknowledge"
	cases := []struct{ method, path, body string }{
		{"GET", list, ""}, {"GET", list + "?limit=0", ""}, {"GET", list + "?limit=101", ""},
		{"GET", list + "?limit=01", ""}, {"GET", list + "?limit=%2B1", ""}, {"GET", list + "?limit=1.0", ""},
		{"GET", list + "?limit=1&limit=2", ""}, {"GET", list + "?limit=1&after_id=", ""},
		{"GET", list + "?limit=1&notice_after_id=", ""}, {"GET", list + "?limit=1&after_id=bad%20id", ""},
		{"GET", list + "?limit=1&notice_after_id=bad%2Fid", ""}, {"GET", list + "?limit=1&notice_after_id=a&notice_after_id=b", ""},
		{"GET", list + "?limit=1&scope=organization", ""}, {"GET", list + "?limit=1&membership_id=other", ""},
		{"GET", list + "?limit=1&actor_principal_id=other", ""}, {"GET", list + "?limit=1&user_id=other", ""},
		{"GET", list + "?limit=1&organization_id=other", ""}, {"GET", list + "?limit=1", "{}"},
		{"DELETE", list + "/bad%3Aid", `{}`}, {"DELETE", unbind + "?", `{}`}, {"DELETE", unbind + "?scope=self", `{}`},
		{"DELETE", unbind, ``}, {"DELETE", unbind, `null`}, {"DELETE", unbind, `[]`},
		{"DELETE", unbind, `{"allow_lockout":null}`}, {"DELETE", unbind, `{"allow_lockout":"false"}`},
		{"DELETE", unbind, `{"allow_lockout":true,"allow_lockout":false}`}, {"DELETE", unbind, `{"Allow_Lockout":true}`},
		{"DELETE", unbind, `{"binding_id":"other"}`}, {"DELETE", unbind, `{"scope":"organization"}`},
		{"DELETE", unbind, "\uFEFF{}"}, {"DELETE", unbind, "{} {}"}, {"DELETE", unbind, "{}" + strings.Repeat(" ", 65536)},
		{"DELETE", unbind, `{"membership_id":"other"}`}, {"DELETE", unbind, `{"actor_principal_id":"other"}`},
		{"POST", ack, `{}`}, {"POST", ack, `{"notice_ids":null}`}, {"POST", ack, `{"notice_ids":[]}`},
		{"POST", ack, `{"notice_ids":["a","a"]}`}, {"POST", ack, `{"notice_ids":["bad:id"]}`},
		{"POST", ack, `{"notice_ids":[null]}`}, {"POST", ack, `{"notice_ids":["a"],"notice_ids":["b"]}`},
		{"POST", ack, `{"notice_ids":["a"],"scope":"self"}`}, {"POST", ack, `{"notice_ids":["a"],"actor_principal_id":"other"}`},
		{"POST", ack + "?", `{"notice_ids":["a"]}`},
	}
	ids := make([]string, 101)
	for i := range ids {
		ids[i] = fmt.Sprintf("notice-%03d", i)
	}
	oversize, _ := json.Marshal(map[string]any{"notice_ids": ids})
	cases = append(cases, struct{ method, path, body string }{"POST", ack, string(oversize)})
	for i, row := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f := newBrowserControlFixture(t)
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(row.method, row.path, row.body))
			if w.Code != 400 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("ambiguous input admitted: status=%d body=%s", w.Code, w.Body.String())
			}
			for _, call := range f.calls() {
				if call.Path != "resolve-access-token" {
					t.Fatalf("invalid input reached %s", call.Path)
				}
			}
		})
	}
}

func TestGatewayExternalIdentitiesRequireBrowserAdmission(t *testing.T) {
	for _, row := range []struct{ method, path, body string }{
		{"GET", "/api/session/external-identities?limit=1", ""},
		{"DELETE", "/api/session/external-identities/binding-2", `{}`},
		{"POST", "/api/session/external-identities/notices/acknowledge", `{"notice_ids":["notice-4"]}`},
	} {
		for _, admission := range []string{"origin", "csrf", "session", "content-type"} {
			if row.method == "GET" && (admission == "csrf" || admission == "content-type") {
				continue
			}
			t.Run(row.method+"/"+admission, func(t *testing.T) {
				f := newBrowserControlFixture(t)
				r := f.request(row.method, row.path, row.body)
				want := 403
				switch admission {
				case "origin":
					r.Header.Set("Origin", "https://foreign.example")
				case "csrf":
					r.Header.Set(session.CSRFHeaderName, "forged")
				case "session":
					r.Header.Del("Cookie")
					want = 401
				case "content-type":
					r.Header.Set("Content-Type", "text/plain")
					want = 415
				}
				w := httptest.NewRecorder()
				f.handler.ServeHTTP(w, r)
				if w.Code != want || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
					t.Fatalf("admission status=%d body=%s", w.Code, w.Body.String())
				}
				for _, call := range f.calls() {
					if call.Path != "resolve-access-token" || admission == "origin" || admission == "session" {
						t.Fatalf("failed admission reached %s", call.Path)
					}
				}
			})
		}
	}
}

func TestGatewayExternalIdentitiesMapErrorsWithoutCookieMutation(t *testing.T) {
	for _, route := range []struct{ method, path, body, rpc string }{
		{"GET", "/api/session/external-identities?limit=1", "", "list-external-identities"},
		{"DELETE", "/api/session/external-identities/binding-2", `{}`, "unbind-external-identity"},
		{"POST", "/api/session/external-identities/notices/acknowledge", `{"notice_ids":["notice-4"]}`, "acknowledge-external-identity-notices"},
	} {
		for _, row := range []struct {
			code, public string
			status, want int
		}{
			{"not_found", "not_found", 404, 404}, {"external_identity_last_method", "external_identity_last_method", 409, 409},
			{"unauthenticated", "unauthenticated", 401, 401}, {"forbidden", "forbidden", 403, 403},
			{"inactive_principal", "unauthenticated", 401, 401}, {"caller_context_invalid", "unauthenticated", 401, 401}, {"caller_context_required", "unauthenticated", 401, 401},
			{"invalid_argument", "invalid_request", 400, 400}, {"internal_error", "identity_unavailable", 500, 503},
		} {
			t.Run(route.method+row.code, func(t *testing.T) {
				f := newBrowserControlFixture(t)
				f.status[route.rpc], f.code[route.rpc] = row.status, row.code
				w := httptest.NewRecorder()
				f.handler.ServeHTTP(w, f.request(route.method, route.path, route.body))
				var result struct {
					Code string `json:"code"`
				}
				if w.Code != row.want || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Code != row.public || strings.Contains(w.Body.String(), "private internal detail") {
					t.Fatalf("wrong public error: status=%d body=%s", w.Code, w.Body.String())
				}
				if w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
					t.Fatal("error changed cookies or enabled caching")
				}
			})
		}
	}
}

func TestGatewayExternalIdentityUnbindReturnsCommitBeforeNextRequestReauthenticates(t *testing.T) {
	f := newBrowserControlFixture(t)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, f.request("DELETE", "/api/session/external-identities/binding-2", `{"allow_lockout":true}`))
	if w.Code != 200 || len(w.Result().Cookies()) != 0 || len(f.calls()) != 2 || !strings.Contains(w.Body.String(), `"current_revoked":true`) {
		t.Fatalf("committed revocation was reauthenticated or lost: status=%d body=%s calls=%v", w.Code, w.Body.String(), f.calls())
	}
	w = httptest.NewRecorder()
	f.handler.ServeHTTP(w, f.request("GET", "/api/session/external-identities?limit=1", ""))
	calls := f.calls()
	if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 || len(calls) != 3 || calls[2].Path != "resolve-access-token" {
		t.Fatalf("revoked session reached inventory: status=%d calls=%v", w.Code, calls)
	}
}

func TestGatewayExternalIdentityMalformedUpstreamIsUnavailable(t *testing.T) {
	for _, row := range []struct{ method, path, body, rpc, response string }{
		{"GET", "/api/session/external-identities?limit=1", "", "list-external-identities", `{"bindings":[],"notices":null}`},
		{"DELETE", "/api/session/external-identities/binding-2", `{}`, "unbind-external-identity", `{"revoked_count":0,"current_revoked":true}`},
		{"POST", "/api/session/external-identities/notices/acknowledge", `{"notice_ids":["notice-4"]}`, "acknowledge-external-identity-notices", `{"acknowledged_count":2}`},
	} {
		t.Run(row.method, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			f.replies[row.rpc] = row.response
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(row.method, row.path, row.body))
			if w.Code != 503 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 || !strings.Contains(w.Body.String(), `"code":"identity_unavailable"`) {
				t.Fatalf("malformed reply was admitted or lost session: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
