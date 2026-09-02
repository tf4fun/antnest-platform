package server

import (
	"context"
	"encoding/json"
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

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
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

func TestCreateModelProfileShapesAuthorityAndSecretOnce(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"model_profile_id":"model-1","revision_id":"model-revision-1"}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/model-profiles", `{
		"profile_key":"deepseek","display_name":"DeepSeek","api_key":"secret-key",
		"model":{"base_url":"https://api.deepseek.com","model":"deepseek-chat","context_window":64000,"max_output_tokens":8192,"supports_images":false}
	}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["request_id"] != "console-request-1" || payload["organization_id"] != "org-1" {
		t.Fatalf("authority fields=%v", payload)
	}
	credential := payload["credential"].(map[string]any)
	if credential["secret_type"] != "bearer" || credential["secret"] != "secret-key" {
		t.Fatalf("credential=%v", credential)
	}
	if strings.Contains(response.Body.String(), "secret-key") {
		t.Fatalf("secret leaked: %s", response.Body.String())
	}
}

func TestCreateTemplateUsesConfiguredRuntimeDigestAndDefaults(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusCreated, `{"template_id":"template-1","revision":1}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodPost, "/api/admin/templates", `{
		"template_key":"personal","name":"Personal Agent","model_profile_revision_id":"model-revision-1",
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
	backend.enqueueFor("/internal/model-profiles", http.StatusOK, `{"items":[],"next_after_id":null}`)
	backend.enqueueFor("/internal/agent-templates", http.StatusOK, `{"items":[],"next_after_id":null}`)
	backend.enqueueFor("/internal/agents", http.StatusOK, `{"items":[],"next_cursor":null}`)
	handler := newTestHandler(t, backend)
	response := requestAdmin(t, handler, http.MethodGet, "/api/admin/overview", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Agents struct {
			Status string `json:"status"`
		} `json:"agents"`
		Defaults struct {
			RuntimeImageRef string `json:"runtime_image_ref"`
		} `json:"defaults"`
	}
	decodeBytes(t, response.Body.Bytes(), &payload)
	if payload.Agents.Status != "available" || payload.Defaults.RuntimeImageRef != testRuntimeDigest || len(backend.calls) != 4 {
		t.Fatalf("overview=%#v calls=%d", payload, len(backend.calls))
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
			"groups":[]}`},
		{name: "model", projector: projectModelProfile, payload: `{
			"model_profile_id":"model-1","organization_id":"org-1","profile_key":"deepseek",
			"display_name":"DeepSeek","revision_id":"revision-1","revision":1,"enabled":true,
			"model":{"model":"deepseek-chat"},"credential_ref":"credential-1",
			"credential_version":"secret-version","created_at":"2026-09-02T00:00:00Z",
			"updated_at":"2026-09-02T00:00:00Z"}`},
		{name: "agent", projector: projectAgent, payload: `{
			"agent_id":"agent-1","organization_id":"org-1","owner_user_id":"user-1","name":"Agent",
			"desired_state":"enabled","lifecycle_state":"available","access_revision":"access-1",
			"runtime":{"runtime_revision":"runtime-1","runtime_execution_id":"execution-secret",
			"mcp_endpoint":"http://runtime.internal/mcp"},"aggregate_sequence":1,
			"created_at":"2026-09-02T00:00:00Z","updated_at":"2026-09-02T00:00:00Z"}`},
		{name: "create", projector: projectCreateAgent, payload: `{
			"agent":{"agent_id":"agent-1","organization_id":"org-1","owner_user_id":"user-1",
			"name":"Agent","desired_state":"enabled","lifecycle_state":"provisioning",
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
			} {
				if strings.Contains(string(projected), forbidden) {
					t.Fatalf("projection leaked %q: %s", forbidden, projected)
				}
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
	handler, err := NewHandler(Config{
		DefaultRuntimeImageRef: testRuntimeDigest,
		RequestTimeout:         time.Second,
		NewRequestID:           func() string { return "console-request-1" },
	}, Dependencies{
		Backend: backend, Assets: fs.FS(assets), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
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
