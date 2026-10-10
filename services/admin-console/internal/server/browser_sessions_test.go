package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const browserSessionsPath = "/api/admin/directory/users/user-target/sessions"

func browserSessionRow() map[string]any {
	return map[string]any{
		"id": "public-session-1", "organization_id": "org-1", "organization_slug": "engineering", "organization_name": "Engineering",
		"created_at": "2026-10-11T00:00:00Z", "last_active_at": "2026-10-11T00:10:00Z", "idle_expires_at": "2026-10-11T00:40:00Z", "expires_at": "2026-10-11T12:00:00Z",
		"user_agent_hint": "<script>plain text</script>", "current": false,
	}
}

func encodedSessionPage(t *testing.T, rows []map[string]any, cursor string) string {
	t.Helper()
	value := map[string]any{"sessions": rows}
	if cursor != "" {
		value["next_after_id"] = cursor
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestBrowserSessionOrganizationListDerivesSignedScopeAndProjectsOnlyPublicFields(t *testing.T) {
	backend := newBackendStub()
	row := browserSessionRow()
	row["token_id"], row["access_token"], row["token_hash"] = "private-sid", "private-secret", "private-hash"
	backend.enqueue(200, encodedSessionPage(t, []map[string]any{row}, "public-session-3"))
	f := newTestHandler(t, backend).(*businessFixture)
	actor := principal.Principal{UserID: "real-admin", OrganizationID: "org-1", MembershipID: "real-membership", SystemRole: "admin", OrganizationRole: "member"}
	r := httptest.NewRequest(http.MethodGet, browserSessionsPath+"?limit=2&after_id=public-session-0", nil)
	r.Header.Set(serviceauth.Header, "Bearer "+f.token)
	r.Header.Set(callercontext.Header, f.sign(actor, "", nil))
	r.Header.Set(principal.HeaderOrganizationID, "forged-org")
	r.Header.Set(principal.HeaderUserID, "forged-user")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != 200 || !reflect.DeepEqual(w.Header().Values("Cache-Control"), []string{"no-store"}) || len(w.Result().Cookies()) != 0 {
		t.Fatalf("list status=%d cache=%q", w.Code, w.Header().Get("Cache-Control"))
	}
	call := backend.singleCall(t)
	var input map[string]any
	decodeBytes(t, call.Body, &input)
	if call.Target != upstream.Identity || call.Method != http.MethodPost || call.Path != "/rpc/identity/list-user-sessions" || call.Query != "" {
		t.Fatalf("wrong operation: %s", call.Path)
	}
	if !reflect.DeepEqual(input, map[string]any{"actor_principal_id": "real-admin", "user_id": "user-target", "scope": "organization", "limit": float64(2), "after_id": "public-session-0"}) {
		t.Fatalf("wrong scope: %v", input)
	}
	expected := encodedSessionPage(t, []map[string]any{browserSessionRow()}, "public-session-3")
	var actual, want any
	decodeBytes(t, w.Body.Bytes(), &actual)
	decodeBytes(t, []byte(expected), &want)
	if !reflect.DeepEqual(actual, want) {
		t.Fatal("session projection changed public fields or exposed private data")
	}
}

func TestBrowserSessionListRejectsCallerScopeAndInvalidPaginationBeforeEffects(t *testing.T) {
	for _, query := range []string{"", "?", "?limit=", "?limit=0", "?limit=101", "?limit=1&limit=2", "?Limit=1", "?limit=+1", "?limit=%2B1", "?limit=01", "?limit=1&after_id=", "?limit=1&after_id=bad%2Fid", "?limit=1&scope=self", "?limit=1&user_id=other", "?limit=1&organization_id=other", "?limit=1&current_token_id=sid"} {
		t.Run(query, func(t *testing.T) {
			backend := newBackendStub()
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, browserSessionsPath+query, "")
			if w.Code != 400 || len(backend.calls) != 0 {
				t.Fatalf("invalid query admitted: status=%d calls=%d", w.Code, len(backend.calls))
			}
		})
	}
	for _, row := range []struct{ path, body string }{{browserSessionsPath + "?limit=1", "{}"}, {"/api/admin/directory/users/bad%2Fid/sessions?limit=1", ""}} {
		backend := newBackendStub()
		w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, row.path, row.body)
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatalf("invalid list admitted: status=%d calls=%d", w.Code, len(backend.calls))
		}
	}
}

func TestBrowserSessionListRejectsMalformedOrForeignUpstreamRows(t *testing.T) {
	changes := map[string]func(map[string]any){
		"foreign organization":    func(v map[string]any) { v["organization_id"] = "org-2" },
		"invalid public id":       func(v map[string]any) { v["id"] = "private/sid" },
		"missing current":         func(v map[string]any) { delete(v, "current") },
		"foreign target current":  func(v map[string]any) { v["current"] = true },
		"missing hint":            func(v map[string]any) { delete(v, "user_agent_hint") },
		"oversized hint":          func(v map[string]any) { v["user_agent_hint"] = strings.Repeat("界", 257) },
		"invalid date":            func(v map[string]any) { v["expires_at"] = "never" },
		"idle exceeds absolute":   func(v map[string]any) { v["idle_expires_at"] = "2026-10-12T12:00:00Z" },
		"created after active":    func(v map[string]any) { v["created_at"] = "2026-10-11T00:20:00Z" },
		"active after idle":       func(v map[string]any) { v["last_active_at"] = "2026-10-11T01:00:00Z" },
		"empty organization name": func(v map[string]any) { v["organization_name"] = " " },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			backend := newBackendStub()
			row := browserSessionRow()
			change(row)
			backend.enqueue(200, encodedSessionPage(t, []map[string]any{row}, ""))
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, browserSessionsPath+"?limit=1", "")
			if w.Code != 502 || strings.Contains(w.Body.String(), "public-session-1") {
				t.Fatalf("unsafe page admitted: status=%d", w.Code)
			}
		})
	}
	for _, page := range []string{`{"sessions":null}`, `{}`, encodedSessionPage(t, []map[string]any{browserSessionRow(), browserSessionRow()}, ""), encodedSessionPage(t, []map[string]any{browserSessionRow()}, "public-session-0")} {
		backend := newBackendStub()
		backend.enqueue(200, page)
		w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, browserSessionsPath+"?limit=1", "")
		if w.Code != 502 {
			t.Fatalf("invalid page admitted: status=%d", w.Code)
		}
	}
	backend := newBackendStub()
	backend.enqueue(200, `{"sessions":[],"next_after_id":"public-session-3"}`)
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, browserSessionsPath+"?limit=1&after_id=public-session-0", "")
	if w.Code != 200 {
		t.Fatalf("empty post-filter page must retain advancing cursor: status=%d", w.Code)
	}
}

func TestBrowserSessionOrganizationRevokeFixesModeAndPreservesCookies(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(200, `{"revoked_count":2,"current_revoked":false,"token_id":"private-sid"}`)
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, browserSessionsPath+"/revoke", `{}`)
	if w.Code != 200 || len(w.Result().Cookies()) != 0 || !reflect.DeepEqual(w.Header().Values("Cache-Control"), []string{"no-store"}) {
		t.Fatalf("revoke status=%d", w.Code)
	}
	call := backend.singleCall(t)
	var input map[string]any
	decodeBytes(t, call.Body, &input)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/revoke-user-sessions" || input["scope"] != "organization" || input["mode"] != "all" || input["actor_principal_id"] != "user-admin" || input["user_id"] != "user-target" || len(input) != 5 {
		t.Fatalf("unsafe revoke input: %v", input)
	}
	if id, ok := input["request_id"].(string); !ok || id == "" {
		t.Fatal("missing audit correlation")
	}
	var out map[string]any
	decodeBytes(t, w.Body.Bytes(), &out)
	if !reflect.DeepEqual(out, map[string]any{"revoked_count": float64(2), "current_revoked": false}) {
		t.Fatal("unsafe revoke projection")
	}
	for _, body := range []string{`{"mode":"others"}`, `{"mode":"all"}`, `{"scope":"self"}`, `{"organization_id":"other"}`, `{"user_id":"other"}`, `{"current_token_id":"sid"}`, `{"except_token_id":"sid"}`, `null`, `{} {}`} {
		backend := newBackendStub()
		w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, browserSessionsPath+"/revoke", body)
		if w.Code != 400 || len(backend.calls) != 0 {
			t.Fatalf("invalid revoke admitted: status=%d", w.Code)
		}
	}
}

func TestBrowserSessionRevokeRejectsImpossibleResultAndReportsSelfRevocation(t *testing.T) {
	for _, scenario := range []struct {
		name, target, result string
		status               int
	}{
		{"foreign current", "user-target", `{"revoked_count":1,"current_revoked":true}`, 502},
		{"self current", "user-admin", `{"revoked_count":1,"current_revoked":true}`, 200},
		{"empty self", "user-admin", `{"revoked_count":0,"current_revoked":false}`, 200},
		{"current with no revocations", "user-admin", `{"revoked_count":0,"current_revoked":true}`, 502},
		{"negative count", "user-admin", `{"revoked_count":-1,"current_revoked":false}`, 502},
		{"missing count", "user-admin", `{"current_revoked":false}`, 502},
		{"missing current", "user-admin", `{"revoked_count":1}`, 502},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(200, scenario.result)
			w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/directory/users/"+scenario.target+"/sessions/revoke", `{}`)
			if w.Code != scenario.status || len(w.Result().Cookies()) != 0 {
				t.Fatalf("unexpected revocation result: status=%d wanted=%d", w.Code, scenario.status)
			}
			if scenario.status == 200 && strings.TrimSpace(w.Body.String()) != scenario.result {
				t.Fatal("revocation result changed")
			}
		})
	}
}

func TestBrowserSessionOperationsRetainSignedAdministratorAndDependencyFailures(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			path, body := browserSessionsPath+"?limit=1", ""
			if method == http.MethodPost {
				path, body = browserSessionsPath+"/revoke", `{}`
			}
			for _, status := range []int{401, 403, 503} {
				backend := newBackendStub()
				backend.enqueue(status, `{"code":"upstream_denied"}`)
				w := requestAdmin(t, newTestHandler(t, backend), method, path, body)
				if w.Code != status || len(w.Result().Cookies()) != 0 || !reflect.DeepEqual(w.Header().Values("Cache-Control"), []string{"no-store"}) {
					t.Fatalf("failure changed: status=%d wanted=%d", w.Code, status)
				}
			}
			backend := newBackendStub()
			f := newTestHandler(t, backend).(*businessFixture)
			r := httptest.NewRequest(method, path, strings.NewReader(body))
			r.Header.Set(serviceauth.Header, "Bearer "+f.token)
			r.Header.Set(callercontext.Header, f.sign(principal.Principal{UserID: "member", OrganizationID: "org-1", MembershipID: "membership", SystemRole: "user", OrganizationRole: "member"}, "", nil))
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != 403 || len(backend.calls) != 0 {
				t.Fatal("non-admin reached browser session operation")
			}
		})
	}
}

func TestBrowserPasswordMutationIsRetiredFromConsole(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(200, `{"status":"changed"}`)
	w := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/account/password", `{"current_password":"old-password","new_password":"long-new-password"}`)
	if w.Code != 403 || len(backend.calls) != 0 {
		t.Fatalf("retired mutation reached Identity: status=%d calls=%d", w.Code, len(backend.calls))
	}
}
