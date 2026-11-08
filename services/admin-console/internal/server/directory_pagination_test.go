package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

const memberUpstreamPage = `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"membership-1","organization_id":"org-1","user_id":"user-1","email":"alice@example.com","display_name":"Alice","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":"opaque-next"}`

const memberUpstreamPagePrivate = `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","credential_ref":"secret"},"membership":{"id":"membership-1","organization_id":"org-1","user_id":"user-1","email":"alice@example.com","display_name":"Alice","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","scim_external_id":"ext-1","credential_ref":"secret"}}],"next_cursor":null}`

const groupUpstreamPage = `{"items":[{"id":"group-1","organization_id":"org-1","display_name":"Operators","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}],"next_cursor":null}`

const groupUpstreamPagePrivate = `{"items":[{"id":"group-1","organization_id":"org-1","display_name":"Operators","source":"scim","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","scim_external_id":"ext-g"}],"next_cursor":null}`

func requestAs(t *testing.T, handler http.Handler, method, path, body string, orgRole string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	systemRole := "user"
	if orgRole == "admin" {
		systemRole = "admin"
	}
	request.Header.Set(principal.HeaderSystemRole, systemRole)
	request.Header.Set(principal.HeaderOrganizationRole, orgRole)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func upstreamBody(t *testing.T, call backendCall) map[string]any {
	t.Helper()
	var body map[string]any
	decodeBytes(t, call.Body, &body)
	return body
}

func TestDirectoryMemberPages(t *testing.T) {
	t.Run("first page forwards trusted actor and defaults", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-members", http.StatusOK, memberUpstreamPage)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory/members", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		call := backend.singleCall(t)
		if call.Method != http.MethodPost || call.Path != "/rpc/identity/list-members" {
			t.Fatalf("upstream call = %s %s", call.Method, call.Path)
		}
		body := upstreamBody(t, call)
		if body["actor_principal_id"] != "user-admin" || body["organization_id"] != "org-1" ||
			body["limit"] != float64(50) {
			t.Fatalf("upstream body = %v", body)
		}
		if _, present := body["cursor"]; present {
			t.Fatalf("first page must not send cursor: %v", body)
		}
		if _, present := body["filter"]; present {
			t.Fatalf("unfiltered page must not send filter: %v", body)
		}
		var page struct {
			Items []struct {
				User       map[string]any `json:"user"`
				Membership map[string]any `json:"membership"`
			} `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}
		decodeBytes(t, response.Body.Bytes(), &page)
		if len(page.Items) != 1 || page.NextCursor == nil || *page.NextCursor != "opaque-next" {
			t.Fatalf("page = %s", response.Body.String())
		}
		user := page.Items[0].User
		for _, field := range []string{"organization_id", "credential_ref", "scim_external_id"} {
			if _, present := user[field]; present {
				t.Fatalf("browser user leaked %s: %v", field, user)
			}
		}
	})

	t.Run("query filters translate to closed upstream filter", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-members", http.StatusOK,
			`{"items":[],"next_cursor":null}`)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet,
			"/api/admin/directory/members?q=%20ALICE%20&role=admin&active=true&source=scim&limit=10&cursor=opaque", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		body := upstreamBody(t, backend.singleCall(t))
		if body["limit"] != float64(10) || body["cursor"] != "opaque" {
			t.Fatalf("upstream body = %v", body)
		}
		filter, ok := body["filter"].(map[string]any)
		if !ok {
			t.Fatalf("upstream filter missing: %v", body)
		}
		if filter["email_prefix"] != "alice" || filter["role"] != "admin" ||
			filter["active"] != true || filter["source"] != "scim" {
			t.Fatalf("upstream filter = %v", filter)
		}
		if len(filter) != 4 {
			t.Fatalf("filter must stay closed: %v", filter)
		}
	})

	t.Run("cursor continuation and empty terminal", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-members", http.StatusOK,
			`{"items":[],"next_cursor":null}`)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet,
			"/api/admin/directory/members?cursor=opaque&limit=200", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		var page struct {
			Items      []any   `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}
		decodeBytes(t, response.Body.Bytes(), &page)
		if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
			t.Fatalf("terminal page = %s", response.Body.String())
		}
	})

	t.Run("upstream invalid_argument maps to shared error", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-members", http.StatusBadRequest,
			`{"error":{"code":"invalid_argument","message":"limit must be between 1 and 200","retryable":false}}`)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet,
			"/api/admin/directory/members?limit=5", "")
		if response.Code == http.StatusOK {
			t.Fatalf("upstream error was swallowed: %s", response.Body.String())
		}
	})

	for _, test := range []struct {
		name string
		path string
		body string
	}{
		{"unknown query key", "/api/admin/directory/members?bogus=1", ""},
		{"retired after", "/api/admin/directory/members?after=abc", ""},
		{"retired after_id", "/api/admin/directory/members?after_id=abc", ""},
		{"retired email_prefix", "/api/admin/directory/members?email_prefix=a", ""},
		{"malformed percent", "/api/admin/directory/members?q=%zz", ""},
		{"empty cursor", "/api/admin/directory/members?cursor=", ""},
		{"blank limit", "/api/admin/directory/members?limit=", ""},
		{"zero limit", "/api/admin/directory/members?limit=0", ""},
		{"over limit", "/api/admin/directory/members?limit=201", ""},
		{"fractional limit", "/api/admin/directory/members?limit=1.5", ""},
		{"text limit", "/api/admin/directory/members?limit=many", ""},
		{"empty role", "/api/admin/directory/members?role=", ""},
		{"unknown role", "/api/admin/directory/members?role=owner", ""},
		{"invalid bool", "/api/admin/directory/members?active=yes", ""},
		{"empty source", "/api/admin/directory/members?source=", ""},
		{"unknown source", "/api/admin/directory/members?source=oidc", ""},
		{"unicode invalid prefix", "/api/admin/directory/members?q=%ff", ""},
		{"oversized prefix", "/api/admin/directory/members?q=" + strings.Repeat("a", 300), ""},
		{"body on GET", "/api/admin/directory/members", `{"limit":5}`},
	} {
		t.Run("request rejected: "+test.name, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, test.path, test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatalf("upstream must not be called: %v", backend.calls)
			}
		})
	}

	for _, test := range []struct {
		name     string
		upstream string
		path     string
	}{
		{"missing next_cursor", `{"items":[]}`, ""},
		{"null items", `{"items":null,"next_cursor":null}`, ""},
		{"items wrong type", `{"items":"x","next_cursor":null}`, ""},
		{"nonempty items nil cursor is fine", `{"items":[],"next_cursor":"opaque"}`, ""},
		{"numeric cursor", `{"items":[],"next_cursor":5}`, ""},
		{"empty cursor", `{"items":[],"next_cursor":""}`, ""},
		{"overlong cursor", `{"items":[],"next_cursor":"` + strings.Repeat("c", 5000) + `"}`, ""},
		{"control char cursor", `{"items":[],"next_cursor":"a` + "\n" + `b"}`, ""},
		{"overbound items", `{"items":[` + strings.Repeat(`{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}},`, 6)[:len(strings.Repeat(`{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}},`, 6))-1] + `],"next_cursor":null}`, "/api/admin/directory/members?limit=5"},
		{"incomplete user", `{"items":[{"user":{"id":"user-1"},"membership":{"id":"m","organization_id":"org-1","user_id":"user-1","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"incomplete membership", `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m"}}],"next_cursor":null}`, ""},
		{"user membership mismatch", `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"user-2","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"unknown role", `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"user-1","email":"a@b.c","display_name":"d","role":"owner","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"unknown source", `{"items":[{"user":{"id":"user-1","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"user-1","email":"a@b.c","display_name":"d","role":"member","source":"oidc","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"empty items nonempty cursor", `{"items":[],"next_cursor":"opaque"}`, ""},
		{"organization mismatch", `{"items":[{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"other-org","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"invalid system_role", `{"items":[{"user":{"id":"u","system_role":"superuser","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"invalid email", `{"items":[{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"u","email":"not-an-email","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":null}`, ""},
		{"repeated cursor", `{"items":[{"user":{"id":"u","system_role":"user","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"},"membership":{"id":"m","organization_id":"org-1","user_id":"u","email":"a@b.c","display_name":"d","role":"member","source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}}],"next_cursor":"opaque-in"}`, "/api/admin/directory/members?cursor=opaque-in"},
	} {
		t.Run("upstream rejected: "+test.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueueFor("/rpc/identity/list-members", http.StatusOK, test.upstream)
			handler := newTestHandler(t, backend)
			path := test.path
			if path == "" {
				path = "/api/admin/directory/members"
			}
			response := requestAdmin(t, handler, http.MethodGet, path, "")
			if response.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), "invalid_upstream") &&
				!strings.Contains(response.Body.String(), "upstream") {
				t.Fatalf("expected upstream error code: %s", response.Body.String())
			}
		})
	}

	t.Run("upstream private fields stripped from browser page", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-members", http.StatusOK, memberUpstreamPagePrivate)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory/members", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		body := response.Body.String()
		for _, field := range []string{"organization_id", "credential_ref", "scim_external_id", "scim_user_name"} {
			if strings.Contains(body, `"`+field+`"`) {
				t.Fatalf("browser page leaked %s: %s", field, body)
			}
		}
	})

	t.Run("denied for non-admin caller", func(t *testing.T) {
		backend := newBackendStub()
		handler := newTestHandler(t, backend)
		response := requestAs(t, handler, http.MethodGet, "/api/admin/directory/members", "", "member")
		if response.Code == http.StatusOK {
			t.Fatalf("member caller reached directory: %s", response.Body.String())
		}
		if len(backend.calls) != 0 {
			t.Fatal("upstream must not be called without authority")
		}
	})
}

func TestDirectoryGroupPages(t *testing.T) {
	t.Run("first page and filters", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-groups", http.StatusOK, groupUpstreamPage)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet,
			"/api/admin/directory/groups?q=%20OPS&active=false&source=scim&limit=10", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		body := upstreamBody(t, backend.singleCall(t))
		filter, ok := body["filter"].(map[string]any)
		if !ok || filter["display_name_prefix"] != "ops" || filter["active"] != false ||
			filter["source"] != "scim" || len(filter) != 3 {
			t.Fatalf("upstream filter = %v", body)
		}
		var page struct {
			Items []struct {
				DisplayName string `json:"display_name"`
				Source      string `json:"source"`
				Active      bool   `json:"active"`
				ID          string `json:"id"`
			} `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}
		decodeBytes(t, response.Body.Bytes(), &page)
		if len(page.Items) != 1 || page.Items[0].DisplayName != "Operators" {
			t.Fatalf("page = %s", response.Body.String())
		}
		if page.Items[0].ID != "" {
			t.Fatalf("group id must not reach the browser: %s", response.Body.String())
		}
	})

	t.Run("group id and private fields stripped", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueueFor("/rpc/identity/list-groups", http.StatusOK, groupUpstreamPagePrivate)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory/groups", "")
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
		body := response.Body.String()
		for _, field := range []string{`"id"`, "organization_id", "scim_external_id"} {
			if strings.Contains(body, field) {
				t.Fatalf("browser group page leaked %s: %s", field, body)
			}
		}
	})

	for _, test := range []struct {
		name string
		path string
	}{
		{"role not accepted on groups", "/api/admin/directory/groups?role=admin"},
		{"retired after", "/api/admin/directory/groups?after=abc"},
		{"empty cursor", "/api/admin/directory/groups?cursor="},
		{"over limit", "/api/admin/directory/groups?limit=201"},
		{"invalid bool", "/api/admin/directory/groups?active=1"},
		{"unknown source", "/api/admin/directory/groups?source=oidc"},
	} {
		t.Run("request rejected: "+test.name, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, test.path, "")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatal("upstream must not be called")
			}
		})
	}

	for name, upstream := range map[string]string{
		"missing display_name":        `{"items":[{"source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}],"next_cursor":null}`,
		"wrong scalar":                `{"items":[{"display_name":5,"source":"local","active":true,"created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z"}],"next_cursor":null}`,
		"empty items nonempty cursor": `{"items":[],"next_cursor":"opaque"}`,
	} {
		t.Run("upstream rejected: "+name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueueFor("/rpc/identity/list-groups", http.StatusOK, upstream)
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory/groups", "")
			if response.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}

	t.Run("denied for non-admin caller", func(t *testing.T) {
		backend := newBackendStub()
		handler := newTestHandler(t, backend)
		response := requestAs(t, handler, http.MethodGet, "/api/admin/directory/groups", "", "member")
		if response.Code == http.StatusOK {
			t.Fatalf("member caller reached groups: %s", response.Body.String())
		}
	})
}
