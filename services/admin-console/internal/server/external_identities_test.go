package server

import (
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const externalMembershipPath = "/api/admin/directory/memberships/membership-1/external-identities"
const externalProviderPath = "/api/admin/directory/identity-providers"

func externalBindingRow() map[string]any {
	return map[string]any{
		"id": "binding-1", "provider_id": "provider-1", "provider_name": "workforce", "provider_display_name": "Workforce",
		"organization_id": "org-1", "organization_slug": "engineering", "organization_name": "Engineering", "membership_id": "membership-1",
		"subject": "  <opaque> e\u0301 😀  ", "method": "scim", "provider_enabled": false,
		"created_at": "2026-10-11T00:00:00Z", "bound_at": "2026-10-11T01:00:00Z", "revoked_at": nil,
	}
}

func externalProviderRow() map[string]any {
	return map[string]any{"id": "provider-1", "name": "workforce", "display_name": "Workforce", "enabled": false,
		"link_policy": "none", "link_domains": []string{}, "authoritative": false, "link_policy_review_required": true}
}

func externalAdminRequest(t *testing.T, backend *backendStub, method, path, body string, actor principal.Principal, key string) *httptest.ResponseRecorder {
	t.Helper()
	f := newTestHandler(t, backend).(*businessFixture)
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set(serviceauth.Header, "Bearer "+f.token)
	r.Header.Set(callercontext.Header, f.sign(actor, "", nil))
	r.Header.Set(principal.HeaderUserID, "forged-user")
	r.Header.Set(principal.HeaderOrganizationID, "forged-org")
	r.Header.Set(principal.HeaderMembershipID, "forged-membership")
	r.Header.Set(principal.HeaderSystemRole, "admin")
	r.Header.Set(principal.HeaderOrganizationRole, "admin")
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func externalAdmin() principal.Principal {
	return principal.Principal{UserID: "user-admin", OrganizationID: "org-1", MembershipID: "membership-1", SystemRole: "user", OrganizationRole: "admin"}
}

func TestExternalIdentityOrganizationRoutesDeriveSignedScope(t *testing.T) {
	for _, row := range []struct {
		method, path, body, rpc string
		reply                   any
		want                    map[string]any
	}{
		{"GET", externalProviderPath + "?limit=2&after_id=provider-0", "", "list-external-identity-providers", map[string]any{"providers": []any{externalProviderRow()}, "next_after_id": "provider-3"}, map[string]any{"actor_principal_id": "user-admin", "limit": float64(2), "after_id": "provider-0"}},
		{"GET", externalMembershipPath + "?limit=2&after_id=binding-0", "", "list-external-identities", map[string]any{"bindings": []any{externalBindingRow()}, "next_after_id": "binding-3"}, map[string]any{"actor_principal_id": "user-admin", "scope": "organization", "membership_id": "membership-1", "limit": float64(2), "after_id": "binding-0"}},
		{"POST", externalMembershipPath, `{"provider_id":"provider-1","subject":"  <opaque> e\u0301 😀  ","restore_revoked":false}`, "bind-external-identity", map[string]any{"binding": externalBindingRow()}, map[string]any{"actor_principal_id": "user-admin", "membership_id": "membership-1", "provider_id": "provider-1", "subject": "  <opaque> e\u0301 😀  ", "restore_revoked": false}},
		{"DELETE", externalMembershipPath + "/binding-1", `{"allow_lockout":false}`, "unbind-external-identity", map[string]any{"revoked_count": 2, "current_revoked": true}, map[string]any{"actor_principal_id": "user-admin", "scope": "organization", "membership_id": "membership-1", "binding_id": "binding-1", "allow_lockout": false}},
	} {
		t.Run(row.method+row.path, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(200, oidcLinkingJSON(t, row.reply))
			w := externalAdminRequest(t, backend, row.method, row.path, row.body, externalAdmin(), "external-identity-command-1")
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			call := backend.singleCall(t)
			if call.Target != upstream.Identity || call.Method != "POST" || call.Path != "/rpc/identity/"+row.rpc || call.Query != "" {
				t.Fatalf("wrong RPC: %#v", call)
			}
			var sent map[string]any
			decodeBytes(t, call.Body, &sent)
			if row.method != "GET" {
				id, ok := sent["request_id"].(string)
				if !ok || !strings.HasPrefix(id, "external-identities-") {
					t.Fatal("missing derived command ID")
				}
				delete(sent, "request_id")
			}
			if !reflect.DeepEqual(sent, row.want) {
				t.Fatalf("unsafe RPC input: got=%v want=%v", sent, row.want)
			}
			var got, want any
			decodeBytes(t, w.Body.Bytes(), &got)
			decodeBytes(t, []byte(oidcLinkingJSON(t, row.reply)), &want)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("changed public response: %s", w.Body.String())
			}
		})
	}
}

func TestExternalIdentityOrganizationListsRejectQueryAuthorityAndInvalidPagination(t *testing.T) {
	for _, path := range []string{externalProviderPath, externalMembershipPath} {
		for _, query := range []string{"", "?", "?limit=0", "?limit=101", "?limit=01", "?limit=%2B1", "?limit=1&limit=2", "?Limit=1", "?limit=1&after_id=", "?limit=1&after_id=bad%2Fid", "?limit=1&scope=self", "?limit=1&organization_id=other", "?limit=1&membership_id=other", "?limit=1&notice_after_id=n-1", "?limit=1&actor_principal_id=other"} {
			t.Run(path+query, func(t *testing.T) {
				backend := newBackendStub()
				w := externalAdminRequest(t, backend, "GET", path+query, "", externalAdmin(), "")
				if w.Code != 400 || len(backend.calls) != 0 {
					t.Fatalf("query admitted: status=%d calls=%d", w.Code, len(backend.calls))
				}
			})
		}
		backend := newBackendStub()
		w := externalAdminRequest(t, backend, "GET", path+"?limit=1", "{}", externalAdmin(), "")
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatal("GET body admitted")
		}
	}
}

func TestExternalIdentityMutationsRejectInvalidInputBeforeEffects(t *testing.T) {
	for i, body := range []string{`{}`, `null`, `[]`, `{} {}`, `{"provider_id":"provider-1"}`, `{"provider_id":"provider-1","subject":null}`, `{"provider_id":"bad:id","subject":"sub"}`, `{"provider_id":"provider-1","subject":""}`, `{"provider_id":"provider-1","subject":"\u0000"}`, `{"provider_id":"provider-1","subject":"\ud800"}`, `{"provider_id":"provider-1","subject":"\udc00"}`, `{"provider_id":"provider-1","subject":"\ud800\u0041"}`, `{"provider_id":"provider-1","subject":"` + strings.Repeat("😀", 256) + `"}`, `{"provider_id":"provider-1","subject":"sub","restore_revoked":null}`, `{"provider_id":"provider-1","subject":"sub","restore_revoked":"true"}`, `{"provider_id":"provider-1","subject":"sub","restore_revoked":false,"restore_revoked":true}`, `{"provider_id":"provider-1","subject":"sub","Restore_revoked":true}`, `{"provider_id":"provider-1","subject":"sub","membership_id":"other"}`, `{"provider_id":"provider-1","subject":"sub","scope":"organization"}`, `{"provider_id":"provider-1","subject":"sub","actor_principal_id":"forged"}`, `{"provider_id":"provider-1","subject":"sub","request_id":"forged"}`, string([]byte{'{', '"', 'p', 'r', 'o', 'v', 'i', 'd', 'e', 'r', '_', 'i', 'd', '"', ':', '"', 'p', '"', ',', '"', 's', 'u', 'b', 'j', 'e', 'c', 't', '"', ':', '"', 0xff, '"', '}'})} {
		t.Run(fmt.Sprint("bind/", i), func(t *testing.T) {
			backend := newBackendStub()
			w := externalAdminRequest(t, backend, "POST", externalMembershipPath, body, externalAdmin(), "external-identity-command-1")
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatalf("invalid bind admitted: status=%d calls=%d", w.Code, len(backend.calls))
			}
		})
	}
	for _, body := range []string{`null`, `[]`, `{} {}`, `{"allow_lockout":null}`, `{"allow_lockout":1}`, `{"Allow_lockout":true}`, `{"allow_lockout":false,"allow_lockout":true}`, `{"scope":"self"}`, `{"organization_id":"other"}`, `{"membership_id":"other"}`, `{"binding_id":"other"}`} {
		t.Run("unbind/"+body, func(t *testing.T) {
			backend := newBackendStub()
			w := externalAdminRequest(t, backend, "DELETE", externalMembershipPath+"/binding-1", body, externalAdmin(), "external-identity-command-1")
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatalf("invalid unbind admitted: status=%d", w.Code)
			}
		})
	}
	for _, method := range []string{"POST", "DELETE"} {
		path, body := externalMembershipPath, `{"provider_id":"provider-1","subject":"sub"}`
		if method == "DELETE" {
			path += "/binding-1"
			body = `{}`
		}
		for _, key := range []string{"", "short"} {
			backend := newBackendStub()
			w := externalAdminRequest(t, backend, method, path, body, externalAdmin(), key)
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatal("unkeyed write admitted")
			}
		}
		for _, query := range []string{"?", "?scope=self"} {
			backend := newBackendStub()
			w := externalAdminRequest(t, backend, method, path+query, body, externalAdmin(), "external-identity-command-1")
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatal("mutation query admitted")
			}
		}
		backend := newBackendStub()
		w := externalAdminRequest(t, backend, method, strings.Replace(path, "membership-1", "bad%2Fid", 1), body, externalAdmin(), "external-identity-command-1")
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatal("invalid Membership admitted")
		}
	}
}

func TestExternalIdentityBindingPreservesOpaqueSubjectAndExplicitChoices(t *testing.T) {
	for _, subject := range []string{" ", "e\u0301", "é", "�", `\ud800`, strings.Repeat("😀", 255)} {
		for _, restore := range []any{nil, false, true} {
			binding := externalBindingRow()
			binding["subject"] = subject
			input := map[string]any{"provider_id": "provider-1", "subject": subject}
			if restore != nil {
				input["restore_revoked"] = restore
			}
			backend := newBackendStub()
			backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"binding": binding}))
			w := externalAdminRequest(t, backend, "POST", externalMembershipPath, oidcLinkingJSON(t, input), externalAdmin(), "external-identity-command-1")
			if w.Code != 200 {
				t.Fatalf("valid subject rejected: status=%d body=%s", w.Code, w.Body.String())
			}
			var sent map[string]any
			decodeBytes(t, backend.singleCall(t).Body, &sent)
			if sent["subject"] != subject || sent["restore_revoked"] != (restore == true) {
				t.Fatalf("opaque identity or choice changed: %v", sent)
			}
		}
	}
	for _, allow := range []any{nil, false, true} {
		input := map[string]any{}
		if allow != nil {
			input["allow_lockout"] = allow
		}
		backend := newBackendStub()
		backend.enqueue(200, `{"revoked_count":0,"current_revoked":false}`)
		w := externalAdminRequest(t, backend, "DELETE", externalMembershipPath+"/binding-1", oidcLinkingJSON(t, input), externalAdmin(), "external-identity-command-1")
		if w.Code != 200 {
			t.Fatal("valid explicit lockout choice rejected")
		}
		var sent map[string]any
		decodeBytes(t, backend.singleCall(t).Body, &sent)
		if sent["allow_lockout"] != (allow == true) {
			t.Fatal("lockout choice changed")
		}
	}
}

func TestExternalIdentityBindingRejectsUnsafeUpstreamRecords(t *testing.T) {
	changes := map[string]func(map[string]any){
		"foreign org": func(v map[string]any) { v["organization_id"] = "org-2" }, "foreign membership": func(v map[string]any) { v["membership_id"] = "membership-2" },
		"invalid id": func(v map[string]any) { v["id"] = "private/sid" }, "invalid provider": func(v map[string]any) { v["provider_id"] = "bad:id" },
		"missing enabled": func(v map[string]any) { delete(v, "provider_enabled") }, "null enabled": func(v map[string]any) { v["provider_enabled"] = nil },
		"missing revoked": func(v map[string]any) { delete(v, "revoked_at") }, "bad revoked": func(v map[string]any) { v["revoked_at"] = false },
		"null subject": func(v map[string]any) { v["subject"] = nil }, "NUL subject": func(v map[string]any) { v["subject"] = "a\x00b" }, "long subject": func(v map[string]any) { v["subject"] = strings.Repeat("界", 256) },
		"method": func(v map[string]any) { v["method"] = "email" }, "FEFF display": func(v map[string]any) { v["provider_display_name"] = "\uFEFF" },
		"blank org": func(v map[string]any) { v["organization_name"] = " " }, "null name": func(v map[string]any) { v["provider_name"] = nil },
		"missing created": func(v map[string]any) { delete(v, "created_at") }, "comma fraction": func(v map[string]any) { v["bound_at"] = "2026-10-11T00:00:00,5Z" },
		"single hour": func(v map[string]any) { v["bound_at"] = "2026-10-11T0:00:00Z" }, "bad offset": func(v map[string]any) { v["bound_at"] = "2026-10-11T00:00:00+24:00" },
		"private field": func(v map[string]any) { v["token_id"] = "private-sid" }, "case alias": func(v map[string]any) { v["Provider_enabled"] = true },
	}
	for name, change := range changes {
		for _, bind := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/bind=%t", name, bind), func(t *testing.T) {
				row := externalBindingRow()
				change(row)
				backend := newBackendStub()
				method, path, body := "GET", externalMembershipPath+"?limit=1", ""
				reply := map[string]any{"bindings": []any{row}}
				if bind {
					method, path, body = "POST", externalMembershipPath, oidcLinkingJSON(t, map[string]any{"provider_id": "provider-1", "subject": externalBindingRow()["subject"]})
					reply = map[string]any{"binding": row}
				}
				backend.enqueue(200, oidcLinkingJSON(t, reply))
				w := externalAdminRequest(t, backend, method, path, body, externalAdmin(), "external-identity-command-1")
				if w.Code != 502 || strings.Contains(w.Body.String(), "private-sid") {
					t.Fatalf("unsafe binding admitted: status=%d body=%s", w.Code, w.Body.String())
				}
			})
		}
	}
}

func TestExternalIdentityRejectsMatchingNonPublicOrganizationID(t *testing.T) {
	for _, bind := range []bool{false, true} {
		actor := externalAdmin()
		actor.OrganizationID = "org:legacy"
		row := externalBindingRow()
		row["organization_id"] = actor.OrganizationID
		method, path, body := "GET", externalMembershipPath+"?limit=1", ""
		reply := map[string]any{"bindings": []any{row}}
		if bind {
			method, path, body = "POST", externalMembershipPath, oidcLinkingJSON(t, map[string]any{"provider_id": "provider-1", "subject": row["subject"]})
			reply = map[string]any{"binding": row}
		}
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, reply))
		w := externalAdminRequest(t, backend, method, path, body, actor, "external-identity-command-1")
		if w.Code != 502 || len(backend.calls) != 1 {
			t.Fatalf("matching nonpublic organization admitted: status=%d body=%s", w.Code, w.Body.String())
		}
	}
}

func TestExternalIdentityRejectsDuplicateAndDescendingIDsWithinPageLimit(t *testing.T) {
	for _, providers := range []bool{false, true} {
		for _, descending := range []bool{false, true} {
			path, key := externalMembershipPath, "bindings"
			factory := externalBindingRow
			if providers {
				path, key, factory = externalProviderPath, "providers", externalProviderRow
			}
			first, second := factory(), factory()
			if descending {
				first["id"] = "row-2"
				second["id"] = "row-1"
			}
			backend := newBackendStub()
			backend.enqueue(200, oidcLinkingJSON(t, map[string]any{key: []any{first, second}}))
			w := externalAdminRequest(t, backend, "GET", path+"?limit=2", "", externalAdmin(), "")
			if w.Code != 502 {
				t.Fatalf("invalid page order admitted: providers=%t descending=%t", providers, descending)
			}
		}
	}
}

func TestExternalIdentityBindResponseMustMatchProviderAndSubject(t *testing.T) {
	for _, field := range []string{"provider_id", "subject"} {
		row := externalBindingRow()
		row[field] = "other-value"
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"binding": row}))
		w := externalAdminRequest(t, backend, "POST", externalMembershipPath, oidcLinkingJSON(t, map[string]any{"provider_id": "provider-1", "subject": externalBindingRow()["subject"]}), externalAdmin(), "external-identity-command-1")
		if w.Code != 502 {
			t.Fatalf("mismatched %s admitted", field)
		}
	}
}

func TestExternalIdentityProviderChooserRejectsUnsafeMetadata(t *testing.T) {
	for _, key := range []string{"id", "name", "display_name", "enabled", "link_policy", "link_domains", "authoritative", "link_policy_review_required"} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missing=%t", key, missing), func(t *testing.T) {
				row := externalProviderRow()
				if missing {
					delete(row, key)
				} else {
					row[key] = nil
				}
				backend := newBackendStub()
				backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"providers": []any{row}}))
				w := externalAdminRequest(t, backend, "GET", externalProviderPath+"?limit=1", "", externalAdmin(), "")
				if w.Code != 502 {
					t.Fatalf("incomplete chooser admitted: %s", w.Body.String())
				}
			})
		}
	}
	for key, value := range map[string]any{"id": "bad:id", "name": "\uFEFF", "link_policy": "unknown", "link_domains": []string{"example.com"}, "client_secret": "private-secret", "organization_id": "org-2"} {
		row := externalProviderRow()
		row[key] = value
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, map[string]any{"providers": []any{row}}))
		w := externalAdminRequest(t, backend, "GET", externalProviderPath+"?limit=1", "", externalAdmin(), "")
		if w.Code != 502 {
			t.Fatalf("unsafe chooser metadata admitted: %s", key)
		}
	}
}

func TestExternalIdentityOrganizationPagination(t *testing.T) {
	for _, providers := range []bool{false, true} {
		path, key, prefix := externalMembershipPath, "bindings", "binding-"
		factory := externalBindingRow
		if providers {
			path, key, prefix = externalProviderPath, "providers", "provider-"
			factory = externalProviderRow
		}
		for _, payload := range []string{`{}`, `{"` + key + `":null}`, `{"` + key + `":[],"next_after_id":null}`, `{"` + key + `":[],"next_after_id":""}`, `{"` + key + `":[],"next_after_id":"` + prefix + `0"}`, oidcLinkingJSON(t, map[string]any{key: []any{factory(), factory()}}), oidcLinkingJSON(t, map[string]any{key: []any{factory()}, "next_after_id": prefix + "0"})} {
			backend := newBackendStub()
			backend.enqueue(200, payload)
			w := externalAdminRequest(t, backend, "GET", path+"?limit=1&after_id="+prefix+"0", "", externalAdmin(), "")
			if w.Code != 502 {
				t.Fatalf("invalid page admitted: %s", payload)
			}
		}
		for _, rows := range []any{[]any{}, []any{factory()}} {
			backend := newBackendStub()
			backend.enqueue(200, oidcLinkingJSON(t, map[string]any{key: rows, "next_after_id": prefix + "3"}))
			w := externalAdminRequest(t, backend, "GET", path+"?limit=2&after_id="+prefix+"0", "", externalAdmin(), "")
			if w.Code != 200 {
				t.Fatalf("advancing cursor rejected: %s", w.Body.String())
			}
		}
		rows := make([]any, 100)
		for i := range rows {
			row := factory()
			row["id"] = fmt.Sprintf("%s%03d", prefix, i)
			rows[i] = row
		}
		backend := newBackendStub()
		backend.enqueue(200, oidcLinkingJSON(t, map[string]any{key: rows}))
		w := externalAdminRequest(t, backend, "GET", path+"?limit=100", "", externalAdmin(), "")
		if w.Code != 200 {
			t.Fatal("100 item page rejected")
		}
	}
	backend := newBackendStub()
	backend.enqueue(200, `{"bindings":[],"notices":[]}`)
	w := externalAdminRequest(t, backend, "GET", externalMembershipPath+"?limit=1", "", externalAdmin(), "")
	if w.Code != 502 {
		t.Fatal("organization response included private notices")
	}
}

func TestExternalIdentityUnbindMatchesCurrentMembership(t *testing.T) {
	for _, row := range []struct {
		membership, body string
		status           int
	}{
		{"membership-1", `{"revoked_count":2,"current_revoked":true}`, 200}, {"membership-2", `{"revoked_count":2,"current_revoked":true}`, 502},
		{"membership-2", `{"revoked_count":2,"current_revoked":false}`, 200}, {"membership-1", `{"revoked_count":0,"current_revoked":false}`, 200},
		{"membership-1", `{"revoked_count":0,"current_revoked":true}`, 502}, {"membership-1", `{"revoked_count":-1,"current_revoked":false}`, 502},
		{"membership-1", `{"revoked_count":null,"current_revoked":false}`, 502}, {"membership-1", `{"revoked_count":1}`, 502},
		{"membership-1", `{"revoked_count":1,"current_revoked":null}`, 502}, {"membership-1", `{"revoked_count":1,"current_revoked":false,"sid":"private"}`, 502},
	} {
		backend := newBackendStub()
		backend.enqueue(200, row.body)
		w := externalAdminRequest(t, backend, "DELETE", strings.Replace(externalMembershipPath, "membership-1", row.membership, 1)+"/binding-1", "{}", externalAdmin(), "external-identity-command-1")
		if w.Code != row.status || len(w.Result().Cookies()) != 0 {
			t.Fatalf("unbind membership mismatch: status=%d want=%d body=%s", w.Code, row.status, w.Body.String())
		}
	}
}

func TestExternalIdentityOrganizationAuthorizationAndSafeErrors(t *testing.T) {
	for _, row := range []struct{ method, path, body string }{{"GET", externalProviderPath + "?limit=1", ""}, {"GET", externalMembershipPath + "?limit=1", ""}, {"POST", externalMembershipPath, `{"provider_id":"provider-1","subject":"sub"}`}, {"DELETE", externalMembershipPath + "/binding-1", "{}"}} {
		actor := externalAdmin()
		actor.OrganizationRole = "member"
		backend := newBackendStub()
		w := externalAdminRequest(t, backend, row.method, row.path, row.body, actor, "external-identity-command-1")
		if w.Code != 403 || len(backend.calls) != 0 {
			t.Fatal("forged admin hints granted access")
		}
		for _, status := range []int{401, 403, 404, 503} {
			backend := newBackendStub()
			backend.enqueue(status, `{"code":"private_error","message":"private-secret"}`)
			w := externalAdminRequest(t, backend, row.method, row.path, row.body, externalAdmin(), "external-identity-command-1")
			if w.Code != status || strings.Contains(w.Body.String(), "private-secret") || len(w.Result().Cookies()) != 0 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("unsafe error: status=%d body=%s", w.Code, w.Body.String())
			}
		}
	}
	for _, row := range []struct{ method, path, body, code string }{{"POST", externalMembershipPath, `{"provider_id":"provider-1","subject":"sub"}`, "external_identity_conflict"}, {"POST", externalMembershipPath, `{"provider_id":"provider-1","subject":"sub"}`, "external_identity_restore_required"}, {"DELETE", externalMembershipPath + "/binding-1", "{}", "external_identity_last_method"}} {
		backend := newBackendStub()
		backend.enqueue(409, `{"code":"`+row.code+`","message":"private-secret"}`)
		w := externalAdminRequest(t, backend, row.method, row.path, row.body, externalAdmin(), "external-identity-command-1")
		if w.Code != 409 || !strings.Contains(w.Body.String(), row.code) || strings.Contains(w.Body.String(), "private-secret") {
			t.Fatalf("targeted conflict lost: %s", w.Body.String())
		}
		if len(backend.calls) != 1 {
			t.Fatal("mutation replayed")
		}
	}
}
