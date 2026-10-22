package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const runtimeBarrierManualHandlerPath = "/internal/agents/agent-1/rebuild"
const runtimeBarrierManualHandlerRecovery = `{"barrier_id":"barrier-original-🧪","expected_runtime_revision":"rtv_original_recovery"}`

func TestRuntimeBarrierManualRecoveryHandlerDispatchesRecoveryWithOriginalOperation(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		claims map[string]any
	}{
		{name: "organization-administrator"},
		{name: "system-administrator", claims: map[string]any{"sys_role": "admin", "org_role": "member"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, service := newRuntimeBarrierManualHandlerFixture(t)
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, runtimeBarrierManualHandlerRequest(f, runtimeBarrierManualHandlerBody(t, runtimeBarrierManualHandlerRecovery), scenario.claims))

			require.Equal(t, http.StatusAccepted, response.Code, response.Body.String())
			require.Equal(t, []application.RuntimeBarrierManualRecoveryInput{runtimeBarrierManualHandlerInput(t)}, service.recoveries)
			require.Empty(t, service.ordinary)
			var operation operationResponse
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &operation))
			require.Equal(t, operationResponse{
				RequestID: runtimeBarrierManualHandlerInput(t).Command.RequestID, AgentID: "agent-1",
				Kind: domain.OperationRebuild, Phase: domain.PhaseDrain, State: domain.OperationRunning,
				CreatedAt: time.Unix(30, 0).UTC(), UpdatedAt: time.Unix(30, 0).UTC(),
			}, operation)
			require.NotContains(t, response.Body.String(), "runtime_execution_id")
			require.NotContains(t, response.Body.String(), "barrier_id")
		})
	}
}

func TestRuntimeBarrierManualRecoveryHandlerKeepsOrdinaryRebuildPath(t *testing.T) {
	f, service := newRuntimeBarrierManualHandlerFixture(t)
	response := httptest.NewRecorder()

	f.raw.ServeHTTP(response, runtimeBarrierManualHandlerRequest(f, runtimeBarrierManualHandlerBody(t, ""), nil))

	require.Equal(t, http.StatusAccepted, response.Code, response.Body.String())
	require.Empty(t, service.recoveries)
	require.Equal(t, []application.RebuildAgentInput{runtimeBarrierManualHandlerInput(t).Command}, service.ordinary)
}

func TestRuntimeBarrierManualRecoveryHandlerRejectsInvalidRecoveryBeforeBusiness(t *testing.T) {
	for _, scenario := range []struct{ name, recovery string }{
		{"null", `null`},
		{"array", `[]`},
		{"string", `"barrier-original"`},
		{"unknown-field", `{"barrier_id":"barrier-original","expected_runtime_revision":"rtv_original_recovery","rebuild_reason":"barrier"}`},
		{"case-alias", `{"Barrier_ID":"barrier-original","expected_runtime_revision":"rtv_original_recovery"}`},
		{"duplicate-key", `{"barrier_id":"barrier-original","barrier_id":"another-barrier","expected_runtime_revision":"rtv_original_recovery"}`},
		{"decoded-duplicate-key", `{"barrier_id":"barrier-original","\u0062arrier_id":"another-barrier","expected_runtime_revision":"rtv_original_recovery"}`},
		{"missing-barrier", `{"expected_runtime_revision":"rtv_original_recovery"}`},
		{"missing-runtime-revision", `{"barrier_id":"barrier-original"}`},
		{"empty-object", `{}`},
		{"numeric-barrier", `{"barrier_id":17,"expected_runtime_revision":"rtv_original_recovery"}`},
		{"null-barrier", `{"barrier_id":null,"expected_runtime_revision":"rtv_original_recovery"}`},
		{"numeric-runtime-revision", `{"barrier_id":"barrier-original","expected_runtime_revision":17}`},
		{"null-runtime-revision", `{"barrier_id":"barrier-original","expected_runtime_revision":null}`},
		{"empty-barrier", `{"barrier_id":"","expected_runtime_revision":"rtv_original_recovery"}`},
		{"empty-runtime-revision", `{"barrier_id":"barrier-original","expected_runtime_revision":""}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, service := newRuntimeBarrierManualHandlerFixture(t)
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, runtimeBarrierManualHandlerRequest(f, runtimeBarrierManualHandlerBody(t, scenario.recovery), nil))

			assertRuntimeBarrierManualHandlerError(t, response, 400, "invalid_request")
			require.Empty(t, service.recoveries)
			require.Empty(t, service.ordinary, "invalid recovery must not fall back to an ordinary Rebuild")
		})
	}
}

func TestRuntimeBarrierManualRecoveryHandlerKeepsConflictCodes(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		err        error
	}{
		{"lifecycle-busy", "lifecycle_conflict", application.ErrLifecycleConflict},
		{"cooldown-or-superseded-binding", "lifecycle_conflict", ports.ErrConcurrentChange},
		{"request-identity-conflict", "request_id_conflict", ports.ErrRequestConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, service := newRuntimeBarrierManualHandlerFixture(t)
			service.err = scenario.err
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, runtimeBarrierManualHandlerRequest(f, runtimeBarrierManualHandlerBody(t, runtimeBarrierManualHandlerRecovery), nil))

			assertRuntimeBarrierManualHandlerError(t, response, 409, scenario.code)
			require.Len(t, service.recoveries, 1)
			require.Empty(t, service.ordinary)
		})
	}
}

func TestRuntimeBarrierManualRecoveryHandlerReauthenticatesIdenticalRecovery(t *testing.T) {
	now := time.Now().Unix()
	for _, scenario := range []struct {
		name, code string
		status     int
		claims     map[string]any
		change     func(*businessFixture, *http.Request)
	}{
		{name: "missing-workload", status: 401, code: "service_unauthenticated", change: func(_ *businessFixture, r *http.Request) { r.Header.Del(serviceauth.Header) }},
		{name: "missing-CCT", status: 401, code: "caller_context_required", change: func(_ *businessFixture, r *http.Request) { r.Header.Del(callercontext.Header) }},
		{name: "bad-CCT", status: 401, code: "caller_context_invalid", change: func(_ *businessFixture, r *http.Request) { r.Header.Set(callercontext.Header, "invalid-cct") }},
		{name: "duplicate-CCT", status: 401, code: "caller_context_invalid", change: func(f *businessFixture, r *http.Request) {
			r.Header.Add(callercontext.Header, f.sign(map[string]any{"agt": "agent-1"}))
		}},
		{name: "expired-CCT", status: 401, code: "caller_context_invalid", claims: map[string]any{"iat": now - 180, "exp": now - 120}},
		{name: "non-administrator", status: 403, code: "forbidden", claims: map[string]any{"sys_role": "user", "org_role": "member"}},
		{name: "cross-organization", status: 403, code: "organization_mismatch", claims: map[string]any{"org": "other-org"}},
		{name: "different-actor", status: 403, code: "actor_mismatch", claims: map[string]any{"sub": "another-admin"}},
		{name: "different-Agent", status: 401, code: "caller_context_invalid", claims: map[string]any{"agt": "other-agent"}},
		{name: "wrong-workload", status: 403, code: "caller_not_allowed", change: func(f *businessFixture, r *http.Request) {
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens["agent-ui"])
			caller, err := f.security.Authentication.Authorize(r, []string{"agent-ui"})
			require.NoError(t, err, "use a genuinely authenticated foreign workload")
			require.Equal(t, "agent-ui", caller)
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, service := newRuntimeBarrierManualHandlerFixture(t)
			body := runtimeBarrierManualHandlerBody(t, runtimeBarrierManualHandlerRecovery)
			accepted := httptest.NewRecorder()
			f.raw.ServeHTTP(accepted, runtimeBarrierManualHandlerRequest(f, body, nil))
			require.Equal(t, http.StatusAccepted, accepted.Code, accepted.Body.String())
			require.Len(t, service.recoveries, 1)
			request := runtimeBarrierManualHandlerRequest(f, body, scenario.claims)
			if scenario.change != nil {
				scenario.change(f, request)
			}
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, request)

			assertRuntimeBarrierManualHandlerError(t, response, scenario.status, scenario.code)
			require.Len(t, service.recoveries, 1, "the rejected repeated request must not reach recovery replay")
			require.Empty(t, service.ordinary)
			for _, credential := range []string{request.Header.Get(serviceauth.Header), request.Header.Get(callercontext.Header), "manual-recovery-cookie", "manual-recovery-hint"} {
				if credential != "" {
					require.NotContains(t, response.Body.String(), credential)
				}
			}
		})
	}
}

func TestRuntimeBarrierManualRecoveryHandlerRetainsJSONMediaAndSizeBoundaries(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		status     int
		change     func(*http.Request, string) string
	}{
		{"missing-media", "unsupported_media_type", 415, func(r *http.Request, body string) string { r.Header.Del("Content-Type"); return body }},
		{"foreign-media", "unsupported_media_type", 415, func(r *http.Request, body string) string { r.Header.Set("Content-Type", "text/plain"); return body }},
		{"duplicate-media", "unsupported_media_type", 415, func(r *http.Request, body string) string {
			r.Header.Add("Content-Type", "application/json")
			return body
		}},
		{"compressed-body", "unsupported_media_type", 415, func(r *http.Request, body string) string { r.Header.Set("Content-Encoding", "gzip"); return body }},
		{"oversize", "request_too_large", 413, func(_ *http.Request, _ string) string { return strings.Repeat(" ", maximumRequestBytes+1) }},
		{"query", "invalid_request", 400, func(r *http.Request, body string) string { r.URL.RawQuery = "organization_id=org-1"; return body }},
		{"unknown-outer-field", "invalid_request", 400, func(_ *http.Request, body string) string {
			return strings.TrimSuffix(body, "}") + `,"rebuild_reason":"barrier"}`
		}},
		{"outer-case-alias", "invalid_request", 400, func(_ *http.Request, body string) string {
			return strings.Replace(body, `"recovery":`, `"Recovery":`, 1)
		}},
		{"BOM", "invalid_request", 400, func(_ *http.Request, body string) string { return "\xef\xbb\xbf" + body }},
		{"invalid-UTF8", "invalid_request", 400, func(_ *http.Request, body string) string {
			return strings.Replace(body, "barrier-original", "invalid-\xff", 1)
		}},
		{"trailing-document", "invalid_request", 400, func(_ *http.Request, body string) string { return body + " {}" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, service := newRuntimeBarrierManualHandlerFixture(t)
			body := runtimeBarrierManualHandlerBody(t, runtimeBarrierManualHandlerRecovery)
			request := runtimeBarrierManualHandlerRequest(f, body, nil)
			body = scenario.change(request, body)
			request.Body = io.NopCloser(strings.NewReader(body))
			request.ContentLength = int64(len(body))
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, request)

			assertRuntimeBarrierManualHandlerError(t, response, scenario.status, scenario.code)
			require.Empty(t, service.recoveries)
			require.Empty(t, service.ordinary)
		})
	}
}

type runtimeBarrierManualHandlerService struct {
	*lifecycleServiceStub
	recoveries []application.RuntimeBarrierManualRecoveryInput
	ordinary   []application.RebuildAgentInput
}

func (service *runtimeBarrierManualHandlerService) RecoverRuntimeBarrier(_ context.Context, input application.RuntimeBarrierManualRecoveryInput) (application.RebuildAgentResult, error) {
	service.recoveries = append(service.recoveries, input)
	return service.rebuildResult, service.err
}

func (service *runtimeBarrierManualHandlerService) RebuildAgent(ctx context.Context, input application.RebuildAgentInput) (application.RebuildAgentResult, error) {
	service.ordinary = append(service.ordinary, input)
	return service.lifecycleServiceStub.RebuildAgent(ctx, input)
}

func newRuntimeBarrierManualHandlerFixture(t *testing.T) (*businessFixture, *runtimeBarrierManualHandlerService) {
	t.Helper()
	input := runtimeBarrierManualHandlerInput(t)
	service := &runtimeBarrierManualHandlerService{lifecycleServiceStub: &lifecycleServiceStub{
		rebuildResult: application.RebuildAgentResult{Operation: application.OperationView{
			RequestID: input.Command.RequestID, AgentID: input.Command.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			CreatedAt: time.Unix(30, 0).UTC(), UpdatedAt: time.Unix(30, 0).UTC(),
		}},
	}}
	f := newAuthenticationFixture(t)
	var err error
	f.raw, err = NewHandler(&catalogServiceStub{}, service, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	require.NoError(t, err)
	return f, service
}

func runtimeBarrierManualHandlerInput(t *testing.T) application.RuntimeBarrierManualRecoveryInput {
	t.Helper()
	requestID, err := ports.RuntimeBarrierRecoveryRequestID("org-1", "agent-1", "barrier-original-🧪")
	require.NoError(t, err)
	return application.RuntimeBarrierManualRecoveryInput{
		Command: application.RebuildAgentInput{
			RequestID: requestID, OrganizationID: "org-1", ActorPrincipalID: "user-admin", AgentID: "agent-1",
			TemplateID: "template-1", TemplateRevision: 2,
		},
		BarrierID: "barrier-original-🧪", ExpectedRuntimeRevision: "rtv_original_recovery",
	}
}

func runtimeBarrierManualHandlerBody(t *testing.T, recovery string) string {
	t.Helper()
	input := runtimeBarrierManualHandlerInput(t)
	body := map[string]any{
		"request_id": input.Command.RequestID, "organization_id": input.Command.OrganizationID,
		"actor_principal_id": input.Command.ActorPrincipalID,
		"template_id":        input.Command.TemplateID, "template_revision": input.Command.TemplateRevision,
	}
	if recovery != "" {
		body["recovery"] = json.RawMessage(recovery)
	}
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	return string(raw)
}

func runtimeBarrierManualHandlerRequest(f *businessFixture, body string, overrides map[string]any) *http.Request {
	f.t.Helper()
	claims := map[string]any{"agt": "agent-1"}
	for key, value := range overrides {
		claims[key] = value
	}
	request := httptest.NewRequest(http.MethodPost, runtimeBarrierManualHandlerPath, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
	request.Header.Set(callercontext.Header, f.sign(claims))
	request.Header.Set("X-Antnest-System-Role", "admin")
	request.Header.Set("X-Antnest-Organization-ID", "forged-organization")
	request.Header.Set("Authorization", "Bearer manual-recovery-hint")
	request.Header.Set("Cookie", "manual-recovery-cookie")
	return request
}

func assertRuntimeBarrierManualHandlerError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, response.Code, response.Body.String())
	var payload errorResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, code, payload.Code)
	require.False(t, payload.Retryable)
}
