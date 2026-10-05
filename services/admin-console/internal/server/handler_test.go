package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestDirectoryUsesTrustedActorAndOrganization(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"users":[{"user":{"id":"user-1"}}],"groups":[]}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/list-directory" {
		t.Fatalf("call=%#v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["actor_principal_id"] != "user-admin" || payload["organization_id"] != "org-1" {
		t.Fatalf("payload=%v", payload)
	}
}

func TestCurrentAccountUsesTrustedScopeAndProjectsOnlyBrowserFields(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{
		"account":{"user_id":"user-admin","organization_id":"org-1",
		"organization_slug":"engineering","organization_name":"Engineering",
		"membership_id":"membership-1","email":"admin@example.com",
		"display_name":"Antnest Administrator","source":"local",
		"local_password_available":true,"password_hash":"must-not-reach-browser"}
	}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/account", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/get-current-account" {
		t.Fatalf("call=%#v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["actor_principal_id"] != "user-admin" || payload["organization_id"] != "org-1" {
		t.Fatalf("payload=%v", payload)
	}
	if !strings.Contains(response.Body.String(), `"display_name":"Antnest Administrator"`) ||
		!strings.Contains(response.Body.String(), `"organization_name":"Engineering"`) ||
		!strings.Contains(response.Body.String(), `"local_password_available":true`) ||
		strings.Contains(response.Body.String(), "password_hash") ||
		strings.Contains(response.Body.String(), "user-admin") ||
		strings.Contains(response.Body.String(), "membership-1") ||
		strings.Contains(response.Body.String(), "org-1") {
		t.Fatalf("unsafe account projection: %s", response.Body.String())
	}
}

func TestCreateLocalUserShapesAuthorityAndDoesNotEchoPassword(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{
		"user":{"id":"user-1","system_role":"user","active":true},
		"membership":{"id":"membership-2","organization_id":"org-1","user_id":"user-1",
		"email":"alice@example.com","display_name":"Alice","role":"member","source":"local","active":true},
		"password":"must-not-reach-browser"
	}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/users", `{
		"email":"alice@example.com","display_name":"Alice",
		"password":"correct horse battery staple","role":"member"
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/create-local-user" {
		t.Fatalf("call=%#v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	requestID, _ := payload["request_id"].(string)
	if !strings.HasPrefix(requestID, "directory-") || payload["actor_principal_id"] != "user-admin" ||
		payload["organization_id"] != "org-1" || payload["password"] != "correct horse battery staple" {
		t.Fatalf("payload=%v", payload)
	}
	if strings.Contains(response.Body.String(), "must-not-reach-browser") ||
		strings.Contains(response.Body.String(), "correct horse battery staple") {
		t.Fatalf("password leaked: %s", response.Body.String())
	}
}

func TestChangeOwnPasswordUsesTrustedPrincipalAndDoesNotEchoSecrets(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{
		"status":"changed",
		"current_password":"must-not-reach-browser",
		"new_password":"must-not-reach-browser"
	}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/account/password", `{
		"current_password":"current correct password",
		"new_password":"replacement correct password"
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/change-local-password" {
		t.Fatalf("call=%#v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	requestID, _ := payload["request_id"].(string)
	if !strings.HasPrefix(requestID, "account-") || payload["actor_principal_id"] != "user-admin" ||
		payload["user_id"] != "user-admin" || payload["current_password"] != "current correct password" ||
		payload["new_password"] != "replacement correct password" {
		t.Fatalf("payload=%v", payload)
	}
	var result map[string]any
	decodeBytes(t, response.Body.Bytes(), &result)
	if result["status"] != "changed" || len(result) != 1 ||
		strings.Contains(response.Body.String(), "password") {
		t.Fatalf("unexpected or secret-bearing response: %s", response.Body.String())
	}
}

func TestChangeOwnPasswordRejectsInvalidLengthBeforeCallingIdentity(t *testing.T) {
	handler := newTestHandler(t, newBackendStub())
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/account/password", `{
		"current_password":"current correct password",
		"new_password":"too-short"
	}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestChangeOwnPasswordDistinguishesCredentialRejection(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"credential", 401, `{"code":"unauthenticated","message":"must-not-reach-browser","password":"secret"}`, "invalid_current_password"},
		{"unknown", 401, `{"code":"unknown"}`, "unknown"},
		{"missing code", 401, `{}`, ""},
		{"inactive actor", 403, `{"code":"forbidden"}`, "forbidden"},
		{"missing credential", 404, `{"code":"not_found"}`, "not_found"},
		{"changed credential", 409, `{"code":"conflict"}`, "conflict"},
		{"unavailable", 503, `{"code":"unavailable"}`, "unavailable"},
		{"wrong status", 500, `{"code":"unauthenticated"}`, "unauthenticated"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(tt.status, tt.body)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/account/password",
				`{"current_password":"old password","new_password":"replacement password"}`)
			var result struct {
				Code string `json:"code"`
			}
			decodeBytes(t, response.Body.Bytes(), &result)
			if response.Code != tt.status || result.Code != tt.code {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 {
				t.Fatalf("unexpected cache or session mutation: %v", response.Header())
			}
			if tt.name == "credential" && response.Body.String() != "{\"code\":\"invalid_current_password\",\"message\":\"The current password is incorrect.\"}\n" {
				t.Fatalf("credential failure was not safely projected: %s", response.Body.String())
			}
			backend.singleCall(t)
		})
	}
}

func TestChangeOwnPasswordDoesNotMapMalformedRejections(t *testing.T) {
	for _, body := range []string{"", "not JSON", "null", `{"code":401}`, `{"code":"unauthenticated"} trailing`} {
		t.Run(body, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusUnauthorized, body)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/account/password",
				`{"current_password":"old password","new_password":"replacement password"}`)
			if response.Code != http.StatusUnauthorized || response.Body.String() != body {
				t.Fatalf("unexpectedly mapped status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestChangeOwnPasswordRequiresTrustedPrincipal(t *testing.T) {
	backend := newBackendStub()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/admin/account/password", strings.NewReader(`{}`))
	newTestHandler(t, backend).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || len(backend.calls) != 0 ||
		strings.Contains(response.Body.String(), "invalid_current_password") {
		t.Fatalf("unexpected admission: status=%d calls=%d body=%s", response.Code, len(backend.calls), response.Body.String())
	}
}

func TestUpdateMembershipIsScopedToTrustedOrganization(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{
		"membership":{"id":"membership-2","organization_id":"org-1","user_id":"user-1",
		"email":"alice.updated@example.com","display_name":"Alice Updated","role":"admin",
		"source":"local","active":false}
	}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/memberships/membership-2", `{
		"email":"alice.updated@example.com","display_name":"Alice Updated","role":"admin","active":false
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	if call.Target != upstream.Identity || call.Path != "/rpc/identity/update-membership" {
		t.Fatalf("call=%#v", call)
	}
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["actor_principal_id"] != "user-admin" || payload["organization_id"] != "org-1" ||
		payload["membership_id"] != "membership-2" || payload["active"] != false {
		t.Fatalf("payload=%v", payload)
	}
}

func TestSetUserActiveRequiresSystemAdministrator(t *testing.T) {
	backend := newBackendStub()
	handler := newTestHandler(t, backend)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/directory/users/user-1/active", strings.NewReader(`{"active":false}`))
	request.Header.Set(principal.HeaderUserID, "organization-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "user")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "test-idempotency-key-0001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || len(backend.calls) != 0 {
		t.Fatalf("status=%d body=%s calls=%#v", response.Code, response.Body.String(), backend.calls)
	}

	backend.enqueue(http.StatusOK, `{"status":"updated"}`)
	response = requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/users/user-1/active", `{"active":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if call.Path != "/rpc/identity/set-user-active" || payload["actor_principal_id"] != "user-admin" ||
		payload["user_id"] != "user-1" || payload["active"] != false {
		t.Fatalf("call=%#v payload=%v", call, payload)
	}
}

func TestProvisioningListsOnlySafeMetadata(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{
		"providers":[{"id":"provider-1","organization_id":"org-1","name":"workforce",
		"display_name":"Workforce","issuer":"https://id.example.com","client_id":"client-1",
		"scopes":["openid"],"enabled":true,"revision":1,
		"authorization_endpoint":"https://id.example.com/auth","token_endpoint":"https://id.example.com/token",
		"token_endpoint_auth_method":"client_secret_basic","id_token_signing_algs":["RS256"],
		"jwks_uri":"https://id.example.com/jwks","created_at":"2026-09-03T08:00:00Z",
		"updated_at":"2026-09-03T08:00:00Z","client_secret":"must-not-reach-browser"}]}`)
	backend.enqueue(http.StatusOK, `{
		"tokens":[{"id":"token-1","organization_id":"org-1","name":"Workday",
		"scopes":["scim:read"],"created_at":"2026-09-03T08:00:00Z",
		"credential":"must-not-reach-browser"}]}`)
	handler := newTestHandler(t, backend)

	providerResponse := requestAdmin(t, handler, http.MethodGet, "/api/admin/provisioning/oidc-providers", "")
	tokenResponse := requestAdmin(t, handler, http.MethodGet, "/api/admin/provisioning/scim-tokens", "")
	if providerResponse.Code != http.StatusOK || strings.Contains(providerResponse.Body.String(), `"client_secret":`) {
		t.Fatalf("Provider response status=%d body=%s", providerResponse.Code, providerResponse.Body.String())
	}
	if tokenResponse.Code != http.StatusOK || strings.Contains(tokenResponse.Body.String(), "credential") {
		t.Fatalf("SCIM response status=%d body=%s", tokenResponse.Code, tokenResponse.Body.String())
	}
	if len(backend.calls) != 2 {
		t.Fatalf("calls=%#v", backend.calls)
	}
	for index, path := range []string{"/rpc/identity/list-oidc-providers", "/rpc/identity/list-scim-tokens"} {
		var payload map[string]any
		decodeBytes(t, backend.calls[index].Body, &payload)
		if backend.calls[index].Target != upstream.Identity || backend.calls[index].Path != path ||
			payload["actor_principal_id"] != "user-admin" || payload["organization_id"] != "org-1" {
			t.Fatalf("call=%#v payload=%v", backend.calls[index], payload)
		}
	}
}

func TestOIDCProvisioningRequiresSystemAdministrator(t *testing.T) {
	backend := newBackendStub()
	handler := newTestHandler(t, backend)
	request := httptest.NewRequest(http.MethodGet, "/api/admin/provisioning/oidc-providers", nil)
	request.Header.Set(principal.HeaderUserID, "organization-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "user")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || len(backend.calls) != 0 {
		t.Fatalf("status=%d body=%s calls=%#v", response.Code, response.Body.String(), backend.calls)
	}
}

func TestIssueSCIMTokenDisclosesCredentialOnceWithoutCaching(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{
		"token":{"id":"token-1","organization_id":"org-1","name":"Workday",
		"scopes":["scim:read","scim:write"],"created_at":"2026-09-03T08:00:00Z"},
		"credential":"ant_scim_one_time_secret","token_hash":"must-not-reach-browser"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/provisioning/scim-tokens", `{
		"name":"Workday","scopes":["scim:read","scim:write"]
	}`)
	if response.Code != http.StatusCreated ||
		!strings.Contains(response.Body.String(), "ant_scim_one_time_secret") ||
		strings.Contains(response.Body.String(), "token_hash") ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache=%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if call.Path != "/rpc/identity/issue-scim-token" || payload["actor_principal_id"] != "user-admin" ||
		payload["organization_id"] != "org-1" || !strings.HasPrefix(payload["request_id"].(string), "provisioning-") {
		t.Fatalf("call=%#v payload=%v", call, payload)
	}
}

func TestOIDCProvisioningShapesCommandsAndNeverReturnsSecret(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{
		"provider":{"id":"provider-1","organization_id":"org-1","name":"workforce",
		"display_name":"Workforce","issuer":"https://id.example.com","client_id":"client-1",
		"scopes":["openid"],"enabled":true,"revision":1,
		"authorization_endpoint":"https://id.example.com/auth","token_endpoint":"https://id.example.com/token",
		"token_endpoint_auth_method":"client_secret_basic","id_token_signing_algs":["RS256"],
		"jwks_uri":"https://id.example.com/jwks","created_at":"2026-09-03T08:00:00Z",
		"updated_at":"2026-09-03T08:00:00Z","client_secret":"must-not-reach-browser"}}`)
	backend.enqueue(http.StatusOK, `{
		"provider":{"id":"provider-1","organization_id":"org-1","name":"workforce",
		"display_name":"Workforce","issuer":"https://id.example.com","client_id":"client-1",
		"scopes":["openid"],"enabled":false,"revision":2,
		"authorization_endpoint":"https://id.example.com/auth","token_endpoint":"https://id.example.com/token",
		"token_endpoint_auth_method":"client_secret_basic","id_token_signing_algs":["RS256"],
		"jwks_uri":"https://id.example.com/jwks","created_at":"2026-09-03T08:00:00Z",
		"updated_at":"2026-09-03T08:01:00Z"}}`)
	handler := newTestHandler(t, backend)

	createResponse := requestAdmin(t, handler, http.MethodPost, "/api/admin/provisioning/oidc-providers", `{
		"name":"workforce","issuer":"https://id.example.com","client_id":"client-1",
		"client_secret":"provider-secret","scopes":["openid"],"enabled":true
	}`)
	toggleResponse := requestAdmin(t, handler, http.MethodPost, "/api/admin/provisioning/oidc-providers/workforce/enabled", `{"enabled":false}`)
	if createResponse.Code != http.StatusCreated || strings.Contains(createResponse.Body.String(), `"client_secret":`) {
		t.Fatalf("create status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	if toggleResponse.Code != http.StatusOK {
		t.Fatalf("toggle status=%d body=%s", toggleResponse.Code, toggleResponse.Body.String())
	}
	var createPayload, togglePayload map[string]any
	decodeBytes(t, backend.calls[0].Body, &createPayload)
	decodeBytes(t, backend.calls[1].Body, &togglePayload)
	if backend.calls[0].Path != "/rpc/identity/upsert-oidc-provider" ||
		createPayload["client_secret"] != "provider-secret" || createPayload["organization_id"] != "org-1" {
		t.Fatalf("create call=%#v payload=%v", backend.calls[0], createPayload)
	}
	if backend.calls[1].Path != "/rpc/identity/set-oidc-provider-enabled" ||
		togglePayload["name"] != "workforce" || togglePayload["enabled"] != false {
		t.Fatalf("toggle call=%#v payload=%v", backend.calls[1], togglePayload)
	}
}

func TestRevokeSCIMTokenUsesTrustedActor(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"status":"revoked"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/provisioning/scim-tokens/token-1/revoke", `{}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if call.Path != "/rpc/identity/revoke-scim-token" || payload["actor_principal_id"] != "user-admin" ||
		payload["token_id"] != "token-1" {
		t.Fatalf("call=%#v payload=%v", call, payload)
	}
}

func TestCreateModelProfileShapesAuthorityWithoutCredentials(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"model_profile_id":"model-1","revision_id":"model-revision-1"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/model-profiles", `{
		"display_name":"DeepSeek","provider_connection_id":"connection-1",
		"model":{"model":"deepseek-chat","context_window":64000,"max_output_tokens":8192,"supports_images":false}
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	requestID, _ := payload["request_id"].(string)
	if !strings.HasPrefix(requestID, "catalog-") || payload["organization_id"] != "org-1" {
		t.Fatalf("authority fields=%v", payload)
	}
	if payload["credential"] != nil || payload["provider_connection_id"] != "connection-1" {
		t.Fatalf("model must reference connection, not carry credentials: %v", payload)
	}
	if strings.Contains(response.Body.String(), "secret-key") {
		t.Fatalf("secret leaked: %s", response.Body.String())
	}
}

func TestModelProfileDetailAndRevisionRemainOrganizationScoped(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"model_profile_id":"model-1","organization_id":"org-1","revision_id":"revision-1","revision":1}`)
	backend.enqueue(http.StatusCreated, `{"model_profile_id":"model-1","organization_id":"org-1","revision_id":"revision-2","revision":2}`)
	handler := newTestHandler(t, backend)

	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/model-profiles/model-1", "")
	if response.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", response.Code, response.Body.String())
	}
	response = requestAdmin(t, handler, http.MethodPost, "/api/admin/model-profiles/model-1/revisions", `{
		"expected_version":1,
		"display_name":"DeepSeek V2",
		"model":{"model":"deepseek-chat","context_window":128000,"max_output_tokens":8192,"supports_images":false}
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("revise status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 2 {
		t.Fatalf("calls=%#v", backend.calls)
	}
	if backend.calls[0].Path != "/internal/model-profiles/model-1" ||
		backend.calls[0].Query != "organization_id=org-1" {
		t.Fatalf("get call=%#v", backend.calls[0])
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[1].Body, &payload)
	if backend.calls[1].Path != "/internal/model-profiles/model-1/revisions" ||
		payload["organization_id"] != "org-1" || payload["expected_version"] != float64(1) {
		t.Fatalf("revision call=%#v payload=%v", backend.calls[1], payload)
	}
	if strings.Contains(response.Body.String(), "replacement-secret") {
		t.Fatalf("secret leaked: %s", response.Body.String())
	}
}

func TestCreateTemplateUsesConfiguredRuntimeDigestAndDefaults(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":1}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates", `{
		"name":"Personal Agent","model_profile_id":"model-1",
		"system_prompt":"You are helpful."
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	decodeBytes(t, backend.singleCall(t).Body, &payload)
	if payload["context_policy_version"] != "context-v1" || payload["max_model_requests"] != float64(32) {
		t.Fatalf("template defaults=%v", payload)
	}
	runtime := payload["runtime"].(map[string]any)
	if runtime["image_ref"] != testRuntimeDigest {
		t.Fatalf("runtime=%v", runtime)
	}
}

func TestTemplateDefaultsExposeOnlyTheConfiguredRuntimeImage(t *testing.T) {
	backend := newBackendStub()
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/template-defaults", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	decodeBytes(t, response.Body.Bytes(), &payload)
	if len(payload) != 1 || payload["runtime_image_ref"] != testRuntimeDigest {
		t.Fatalf("defaults=%v", payload)
	}
	if len(backend.calls) != 0 {
		t.Fatalf("template defaults unexpectedly called an owner service: %#v", backend.calls)
	}
}

func TestTemplateDetailAndRevisionRemainOrganizationScoped(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"template_id":"template-1","organization_id":"org-1","revision":1}`)
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","organization_id":"org-1","revision":2}`)
	handler := newTestHandler(t, backend)

	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/templates/template-1", "")
	if response.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", response.Code, response.Body.String())
	}
	response = requestAdmin(t, handler, http.MethodPost, "/api/admin/templates/template-1/revisions", `{
		"name":"Personal V2","model_profile_id":"model-2",
		"system_prompt":"Updated prompt","max_model_requests":24,
		"runtime":{"image_ref":"`+testRuntimeDigest+`","resources":{"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456}}
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("revise status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 2 {
		t.Fatalf("calls=%#v", backend.calls)
	}
	if backend.calls[0].Path != "/internal/agent-templates/template-1" ||
		backend.calls[0].Query != "organization_id=org-1" {
		t.Fatalf("get call=%#v", backend.calls[0])
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[1].Body, &payload)
	if backend.calls[1].Path != "/internal/agent-templates/template-1/revisions" ||
		payload["organization_id"] != "org-1" || payload["context_policy_version"] != "context-v1" {
		t.Fatalf("revision call=%#v payload=%v", backend.calls[1], payload)
	}
}

func TestHistoricalCatalogRevisionReadsRemainOrganizationScopedAndSecretFree(t *testing.T) {
	t.Parallel()

	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{
		"template_id":"template-1","organization_id":"org-1","template_key":"personal",
		"name":"Personal","revision":1,"model_profile_id":"model-1",
		"system_prompt":"historical","max_model_requests":8,"context_policy_version":"context-v1",
		"runtime":{"image_ref":"`+testRuntimeDigest+`","resources":{"memory_bytes":1073741824,"pids_limit":256,"tmpfs_bytes":268435456}},
		"skill_refs":[],"enabled":true,"created_at":"2026-09-03T00:00:00Z","updated_at":"2026-09-03T00:00:00Z"
	}`)
	handler := newTestHandler(t, backend)

	modelResponse := requestAdmin(
		t, handler, http.MethodGet,
		"/api/admin/model-profile-revisions/model-revision-1", "",
	)
	if modelResponse.Code != http.StatusForbidden || len(backend.calls) != 0 {
		t.Fatalf("historical model status=%d body=%s", modelResponse.Code, modelResponse.Body.String())
	}
	templateResponse := requestAdmin(
		t, handler, http.MethodGet,
		"/api/admin/templates/template-1/revisions/1", "",
	)
	if templateResponse.Code != http.StatusOK || !strings.Contains(templateResponse.Body.String(), `"system_prompt":"historical"`) {
		t.Fatalf("historical template status=%d body=%s", templateResponse.Code, templateResponse.Body.String())
	}

	if len(backend.calls) != 1 ||
		backend.calls[0].Path != "/internal/agent-templates/template-1/revisions/1" ||
		backend.calls[0].Query != "organization_id=org-1" {
		t.Fatalf("historical catalog calls=%#v", backend.calls)
	}
}

func TestCreateAgentUsesCurrentOrganizationAndSelectedOwner(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusAccepted, `{"agent":{"agent_id":"agent-1","organization_id":"org-1"},"operation":{"request_id":"console-request-1"}}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/agents", `{
		"owner_user_id":"user-1","name":"Agent #1","template_id":"template-1","template_revision":1
	}`)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	decodeBytes(t, backend.singleCall(t).Body, &payload)
	requestID, _ := payload["request_id"].(string)
	if payload["organization_id"] != "org-1" || payload["actor_principal_id"] != "user-admin" ||
		payload["owner_user_id"] != "user-1" || !strings.HasPrefix(requestID, "lifecycle-") {
		t.Fatalf("payload=%v", payload)
	}
}

func TestListEndpointsKeepPaginationAndDeletedVisibilityOrganizationScoped(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"items":[],"next_after_id":null}`)
	backend.enqueue(http.StatusOK, `{"items":[],"next_after_id":null}`)
	backend.enqueue(http.StatusOK, `{"items":[],"next_cursor":null}`)
	backend.enqueue(http.StatusOK, `{"items":[],"next_cursor":null}`)
	handler := newTestHandler(t, backend)

	response := requestAdmin(
		t, handler, http.MethodGet,
		"/api/admin/model-profiles?after_id=model-9&limit=25", "",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("models status=%d body=%s", response.Code, response.Body.String())
	}
	response = requestAdmin(
		t, handler, http.MethodGet,
		"/api/admin/templates?after_id=template-9&limit=25", "",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("templates status=%d body=%s", response.Code, response.Body.String())
	}
	response = requestAdmin(t, handler, http.MethodGet, "/api/admin/agents?limit=25", "")
	if response.Code != http.StatusOK {
		t.Fatalf("current status=%d body=%s", response.Code, response.Body.String())
	}
	response = requestAdmin(
		t, handler, http.MethodGet,
		"/api/admin/agents?view=deleted&cursor=cursor-9&limit=25", "",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("deleted status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 4 {
		t.Fatalf("calls=%#v", backend.calls)
	}
	if backend.calls[0].Path != "/internal/model-profiles" ||
		backend.calls[0].Query != "after_id=model-9&limit=25&organization_id=org-1" {
		t.Fatalf("model call=%#v", backend.calls[0])
	}
	if backend.calls[1].Path != "/internal/agent-templates" ||
		backend.calls[1].Query != "after_id=template-9&limit=25&organization_id=org-1" {
		t.Fatalf("template call=%#v", backend.calls[1])
	}
	if backend.calls[2].Path != "/internal/agents" ||
		backend.calls[2].Query != "limit=25&organization_id=org-1" {
		t.Fatalf("current call=%#v", backend.calls[2])
	}
	if backend.calls[3].Path != "/internal/agents" ||
		backend.calls[3].Query != "cursor=cursor-9&include_deleted=true&lifecycle_state=deleted&limit=25&organization_id=org-1" {
		t.Fatalf("deleted call=%#v", backend.calls[3])
	}
}

func TestListEndpointsRejectInvalidPaginationWithoutCallingAuthorities(t *testing.T) {
	tests := []string{
		"/api/admin/model-profiles?unknown=true",
		"/api/admin/model-profiles?limit=0",
		"/api/admin/templates?limit=101",
		"/api/admin/templates?after_id=one&after_id=two",
		"/api/admin/agents?view=all",
		"/api/admin/agents?include_deleted=true",
		"/api/admin/agents?cursor=one&cursor=two",
	}
	for _, path := range tests {
		t.Run(path, func(t *testing.T) {
			backend := newBackendStub()
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, path, "")
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_request"`) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatalf("invalid query reached authority: %#v", backend.calls)
			}
		})
	}
}

func TestLifecycleCommandDelegatesTenantAuthorityToAgentController(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusNotFound, `{"code":"agent_not_found"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/agents/agent-2/disable", `{}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0].Method != http.MethodPost ||
		backend.calls[0].Path != "/internal/agents/agent-2/disable" {
		t.Fatalf("calls=%#v", backend.calls)
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[0].Body, &payload)
	if payload["organization_id"] != "org-1" || payload["actor_principal_id"] != "user-admin" {
		t.Fatalf("authority payload=%v", payload)
	}
}

func TestLifecycleCommandForwardsStableOrganizationScopedRequest(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusAccepted, `{"request_id":"lifecycle-result","agent_id":"agent-1","kind":"disable","state":"running"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/agents/agent-1/disable", `{}`)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0].Path != "/internal/agents/agent-1/disable" {
		t.Fatalf("calls=%#v", backend.calls)
	}
	var payload map[string]any
	decodeBytes(t, backend.calls[0].Body, &payload)
	requestID, _ := payload["request_id"].(string)
	if !strings.HasPrefix(requestID, "lifecycle-") || payload["organization_id"] != "org-1" ||
		payload["actor_principal_id"] != "user-admin" {
		t.Fatalf("payload=%v", payload)
	}
}

func TestLifecycleCommandRequiresIdempotencyKey(t *testing.T) {
	backend := newBackendStub()
	handler := newTestHandler(t, backend)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/agents/agent-1/disable", strings.NewReader(`{}`))
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
		t.Fatalf("status=%d body=%s calls=%#v", response.Code, response.Body.String(), backend.calls)
	}
}

func TestEventWatchFlushesHeadersBeforeTheFirstEvent(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, "id: 1\nevent: agent_event\ndata: {\"event_id\":\"event-1\",\"global_sequence\":1,\"aggregate_sequence\":1,\"schema_version\":1,\"agent_id\":\"agent-1\",\"event_type\":\"agent_ready\",\"occurred_at\":\"2026-09-02T00:00:00Z\",\"data\":{\"runtime_mcp_endpoint\":\"http://private\"}}\n\n")
	handler := newTestHandler(t, backend)
	request := httptest.NewRequest(http.MethodGet, "/api/admin/agents/agent-1/events/watch", nil)
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	response := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || !response.flushed {
		t.Fatalf("status=%d flushed=%v body=%s", response.Code, response.flushed, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "runtime_mcp_endpoint") || strings.Contains(response.Body.String(), "private") {
		t.Fatalf("private event data leaked: %s", response.Body.String())
	}
}

func TestOverviewAggregatesAuthoritativeReadsAndPresentationDefaults(t *testing.T) {
	backend := newBackendStub()
	backend.enqueueFor("/rpc/identity/list-directory", http.StatusOK, `{"users":[],"groups":[]}`)
	backend.enqueueFor("/internal/model-profiles", http.StatusOK, `{"items":[],"next_after_id":"model-next"}`)
	backend.enqueueFor("/internal/agent-templates", http.StatusOK, `{"items":[],"next_after_id":"template-next"}`)
	backend.enqueueFor("/internal/agents", http.StatusOK, `{"items":[],"next_cursor":"agent-next"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/overview", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Agents struct {
			Status string `json:"status"`
			Data   struct {
				NextCursor string `json:"next_cursor"`
			} `json:"data"`
		} `json:"agents"`
		ModelProfiles struct {
			Data struct {
				NextAfterID string `json:"next_after_id"`
			} `json:"data"`
		} `json:"model_profiles"`
		Templates struct {
			Data struct {
				NextAfterID string `json:"next_after_id"`
			} `json:"data"`
		} `json:"templates"`
		Defaults struct {
			RuntimeImageRef string `json:"runtime_image_ref"`
		} `json:"defaults"`
	}
	decodeBytes(t, response.Body.Bytes(), &payload)
	if payload.Agents.Status != "available" || payload.Defaults.RuntimeImageRef != testRuntimeDigest || len(backend.calls) != 4 {
		t.Fatalf("overview=%#v calls=%d", payload, len(backend.calls))
	}
	if payload.Agents.Data.NextCursor != "agent-next" ||
		payload.ModelProfiles.Data.NextAfterID != "model-next" ||
		payload.Templates.Data.NextAfterID != "template-next" {
		t.Fatalf("overview continuation metadata was not preserved: %#v", payload)
	}
}

func TestOverviewFetchesConcurrentlyAndDegradesOptionalSections(t *testing.T) {
	backend := newOverviewBarrierBackend()
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/overview", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Directory struct {
			Status string         `json:"status"`
			Error  *overviewError `json:"error"`
		} `json:"directory"`
		Agents struct {
			Status string `json:"status"`
		} `json:"agents"`
	}
	decodeBytes(t, response.Body.Bytes(), &payload)
	if payload.Directory.Status != "unavailable" || payload.Directory.Error == nil ||
		payload.Agents.Status != "available" {
		t.Fatalf("overview=%#v", payload)
	}
	if payload.Directory.Error.Code != "upstream_rejected" ||
		payload.Directory.Error.Message != "Directory could not be refreshed" {
		t.Fatalf("directory error=%#v", payload.Directory.Error)
	}
}

func TestOverviewSectionFailureNamesResourceWithoutLeakingUpstreamDetails(t *testing.T) {
	tests := []struct {
		name        string
		result      overviewCallResult
		wantStatus  int
		wantCode    string
		wantMessage string
	}{
		{
			name:        "transport",
			result:      overviewCallResult{err: errors.New("dial identity.internal: private failure")},
			wantStatus:  http.StatusServiceUnavailable,
			wantCode:    "dependency_unavailable",
			wantMessage: "Directory could not be refreshed",
		},
		{
			name:        "rejected",
			result:      overviewCallResult{response: bufferedResponse{status: http.StatusBadGateway}},
			wantStatus:  http.StatusBadGateway,
			wantCode:    "upstream_rejected",
			wantMessage: "Directory could not be refreshed",
		},
		{
			name: "invalid response",
			result: overviewCallResult{err: &bufferedFetchError{
				status: http.StatusBadGateway, code: "invalid_upstream_response",
				message: "private failure", cause: errors.New("identity.internal"),
			}},
			wantStatus:  http.StatusBadGateway,
			wantCode:    "invalid_upstream_response",
			wantMessage: "Directory could not be refreshed",
		},
		{
			name:        "unexpected redirect",
			result:      overviewCallResult{response: bufferedResponse{status: http.StatusFound}},
			wantStatus:  http.StatusBadGateway,
			wantCode:    "upstream_rejected",
			wantMessage: "Directory could not be refreshed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			section := overviewSectionFromResult("Directory", test.result)
			if section.Error == nil || section.Error.Status != test.wantStatus ||
				section.Error.Code != test.wantCode || section.Error.Message != test.wantMessage {
				t.Fatalf("section=%#v", section)
			}
			encoded, err := json.Marshal(section)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "identity.internal") || strings.Contains(string(encoded), "private failure") {
				t.Fatalf("upstream detail leaked: %s", encoded)
			}
		})
	}
}

func TestBrowserProjectionsDoNotExposeControlPlaneFields(t *testing.T) {
	tests := []struct {
		name      string
		projector payloadProjector
		payload   string
	}{
		{name: "directory", projector: projectDirectory, payload: `{
			"users":[{"user":{"id":"user-1","system_role":"user","active":true,
			"created_at":"2026-09-02T00:00:00Z","updated_at":"2026-09-02T00:00:00Z"},
			"membership":{"id":"membership-1","organization_id":"org-1","user_id":"user-1",
			"email":"user@example.com","display_name":"User","role":"member","source":"scim",
			"active":true,"scim_external_id":"external-secret","scim_user_name":"external-name",
			"created_at":"2026-09-02T00:00:00Z","updated_at":"2026-09-02T00:00:00Z"}}],
			"groups":[{"id":"group-secret","display_name":"Engineering","source":"scim",
			"active":true,"created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}]}`},
		{name: "oidc", projector: projectOIDCProviderList, payload: `{"providers":[{
			"id":"provider-secret","organization_id":"org-1","name":"workforce",
			"display_name":"Workforce login","issuer":"https://identity.example.com",
			"client_id":"antnest","scopes":["openid"],"enabled":true,"revision":1,
			"authorization_endpoint":"https://identity.example.com/authorize",
			"token_endpoint":"https://identity.example.com/token",
			"token_endpoint_auth_method":"client_secret_post","id_token_signing_algs":["RS256"],
			"jwks_uri":"https://identity.example.com/jwks","created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}]}`},
		{name: "scim", projector: projectSCIMTokenList, payload: `{"tokens":[{
			"id":"token-action-id","organization_id":"org-1","name":"HR directory",
			"scopes":["scim:read","scim:write"],"created_at":"2026-09-02T00:00:00Z"}]}`},
		{name: "model", projector: projectModelProfile, payload: `{
			"model_profile_id":"model-1","organization_id":"org-1","profile_key":"deepseek",
			"display_name":"DeepSeek","revision_id":"revision-1","revision":1,"enabled":true,
			"model":{"model":"deepseek-chat"},"credential_ref":"credential-1",
			"credential_version":"secret-version","created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}`},
		{name: "template", projector: projectTemplate, payload: `{
			"template_id":"template-1","organization_id":"org-1","template_key":"research",
			"name":"Research","revision":1,"model_profile_id":"model-1",
			"system_prompt":"Work carefully.","max_model_requests":8,
			"context_policy_version":"context-v1","runtime":{"image_ref":"runtime@sha256:abc"},
			"skill_refs":[],"enabled":true,"created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}`},
		{name: "agent", projector: projectAgent, payload: `{
			"agent_id":"agent-1","organization_id":"org-1","owner_user_id":"user-1","name":"Agent",
			"desired_state":"enabled","lifecycle_state":"created","activation_state":"enabled","runtime_state":"available","access_revision":"access-1",
			"configuration":{"template":{"template_id":"template-1","revision":2,"name":"Research"},
			"model_profile":{"model_profile_id":"model-1","revision_id":"model-revision-4",
			"revision":4,"name":"DeepSeek","model":{"base_url":"https://api.deepseek.com/v1",
			"model":"deepseek-chat","context_window":128000,"max_output_tokens":8192,
			"supports_images":false},"credential_ref":"credential-secret"},
			"max_model_requests":24,"context_policy_version":"context-v1",
			"runtime":{"image_ref":"antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"resources":{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864}}},
			"runtime":{"runtime_revision":"runtime-1","runtime_execution_id":"execution-secret",
			"mcp_endpoint":"http://runtime.internal/mcp"},"aggregate_sequence":1,
			"created_at":"2026-09-02T00:00:00Z","updated_at":"2026-09-02T00:00:00Z"}`},
		{name: "create", projector: projectCreateAgent, payload: `{
			"agent":{"agent_id":"agent-1","organization_id":"org-1","owner_user_id":"user-1",
			"name":"Agent","desired_state":"enabled","lifecycle_state":"not_created","runtime_state":"unknown",
			"access_revision":"access-1","aggregate_sequence":1,"created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"},"agent_access_subject":"subject-secret",
			"operation":{"request_id":"request-1","agent_id":"agent-1","kind":"create",
			"phase":"network_ensure","state":"running","created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projected, err := test.projector([]byte(test.payload))
			if err != nil {
				t.Fatalf("project: %v", err)
			}
			for _, forbidden := range []string{
				"credential_ref", "credential_version", "access_revision", "agent_access_subject",
				"runtime_execution_id", "mcp_endpoint", "secret-version", "subject-secret", "runtime.internal",
				"scim_external_id", "scim_user_name", "external-secret", "external-name",
				"organization_id", "group-secret", "provider-secret",
				"profile_key", "template_key",
			} {
				if strings.Contains(string(projected), forbidden) {
					t.Fatalf("projection leaked %q: %s", forbidden, projected)
				}
			}
			if test.name == "agent" {
				for _, required := range []string{
					`"template_id":"template-1"`, `"name":"Research"`,
					`"model":"deepseek-chat"`, `"context_policy_version":"context-v1"`,
				} {
					if !strings.Contains(string(projected), required) {
						t.Fatalf("projection omitted %q: %s", required, projected)
					}
				}
			}
			if test.name == "scim" && !strings.Contains(string(projected), `"id":"token-action-id"`) {
				t.Fatalf("SCIM projection omitted revoke identity: %s", projected)
			}
		})
	}
}

func TestHandlerRejectsMissingTrustedPrincipalAndServesSPAFallback(t *testing.T) {
	backend := newBackendStub()
	handler := newTestHandler(t, backend)
	request := httptest.NewRequest(http.MethodGet, "/api/admin/agents", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing principal status=%d", response.Code)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/agents/agent-1", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Antnest Console") {
		t.Fatalf("SPA fallback status=%d body=%s", response.Code, response.Body.String())
	}
}

const testRuntimeDigest = "antnest/antnest-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func newTestHandler(t *testing.T, backend Backend) http.Handler {
	t.Helper()
	assets := fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<!doctype html><title>Antnest Console</title>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log('app')")},
	}
	handler := newBusinessHandler(t, Config{
		DefaultRuntimeImageRef: testRuntimeDigest,
		RequestTimeout:         time.Second,
	}, Dependencies{
		Backend: backend, Assets: fs.FS(assets), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return handler
}

func requestAdmin(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set(principal.HeaderUserID, "user-admin")
	request.Header.Set(principal.HeaderOrganizationID, "org-1")
	request.Header.Set(principal.HeaderMembershipID, "membership-1")
	request.Header.Set(principal.HeaderSystemRole, "admin")
	request.Header.Set(principal.HeaderOrganizationRole, "admin")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if method == http.MethodPost {
		request.Header.Set("Idempotency-Key", "test-idempotency-key-0001")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeBytes(t *testing.T, payload []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(payload, target); err != nil {
		t.Fatalf("decode %s: %v", payload, err)
	}
}

type backendCall struct {
	Target upstream.Target
	Method string
	Path   string
	Query  string
	Body   []byte
}

type flushRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (response *flushRecorder) Flush() {
	response.flushed = true
	response.ResponseRecorder.Flush()
}

type backendResponse struct {
	status int
	body   string
}

type backendStub struct {
	mutex     sync.Mutex
	calls     []backendCall
	responses []backendResponse
	byPath    map[string]backendResponse
	readyErr  error
}

func newBackendStub() *backendStub { return &backendStub{byPath: make(map[string]backendResponse)} }

func (backend *backendStub) enqueue(status int, body string) {
	backend.mutex.Lock()
	defer backend.mutex.Unlock()
	backend.responses = append(backend.responses, backendResponse{status: status, body: body})
}

func (backend *backendStub) enqueueFor(path string, status int, body string) {
	backend.mutex.Lock()
	defer backend.mutex.Unlock()
	backend.byPath[path] = backendResponse{status: status, body: body}
}

func (backend *backendStub) Do(
	_ context.Context,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
) (*http.Response, error) {
	backend.mutex.Lock()
	backend.calls = append(backend.calls, backendCall{
		Target: target, Method: method, Path: path, Query: query, Body: append([]byte(nil), body...),
	})
	response := backendResponse{status: http.StatusOK, body: `{}`}
	if specific, ok := backend.byPath[path]; ok {
		response = specific
	} else if len(backend.responses) > 0 {
		response, backend.responses = backend.responses[0], backend.responses[1:]
	}
	backend.mutex.Unlock()
	return &http.Response{
		StatusCode: response.status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(response.body)),
	}, nil
}

func (backend *backendStub) Ready(context.Context, upstream.Target) error { return backend.readyErr }

func (backend *backendStub) singleCall(t *testing.T) backendCall {
	t.Helper()
	backend.mutex.Lock()
	defer backend.mutex.Unlock()
	if len(backend.calls) != 1 {
		t.Fatalf("calls=%#v", backend.calls)
	}
	return backend.calls[0]
}

type overviewBarrierBackend struct {
	mutex   sync.Mutex
	started int
	release chan struct{}
}

func newOverviewBarrierBackend() *overviewBarrierBackend {
	return &overviewBarrierBackend{release: make(chan struct{})}
}

func (backend *overviewBarrierBackend) Do(
	ctx context.Context,
	_ upstream.Target,
	_ string,
	path string,
	_ string,
	_ []byte,
) (*http.Response, error) {
	backend.mutex.Lock()
	backend.started++
	if backend.started == 4 {
		close(backend.release)
	}
	backend.mutex.Unlock()
	select {
	case <-backend.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	status, body := http.StatusOK, `{"items":[]}`
	switch path {
	case "/rpc/identity/list-directory":
		status, body = http.StatusServiceUnavailable, `{"code":"dependency_unavailable"}`
	case "/internal/model-profiles", "/internal/agent-templates":
		body = `{"items":[],"next_after_id":null}`
	case "/internal/agents":
		body = `{"items":[],"next_cursor":null}`
	}
	return &http.Response{
		StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}},
		Body: io.NopCloser(strings.NewReader(body)),
	}, nil
}

func (*overviewBarrierBackend) Ready(context.Context, upstream.Target) error { return nil }
