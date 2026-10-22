package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const runtimeBarrierProjectionHandlerPath = "/internal/agents/agent-1?organization_id=org-1"

func TestRuntimeBarrierRecoveryProjectionHandlerSerializesClosedReadOnlyWire(t *testing.T) {
	for _, mode := range []string{"auto", "notify", "manual"} {
		for _, hasDeadline := range []bool{false, true} {
			name := mode + "/null-cooldown"
			if hasDeadline {
				name = mode + "/UTC-cooldown"
			}
			t.Run(name, func(t *testing.T) {
				projection := runtimeBarrierProjectionHandlerProjection(t)
				projection.Mode = mode
				var deadline any
				if hasDeadline {
					until := time.Date(2026, time.October, 23, 1, 2, 3, 123456789, time.UTC)
					projection.CooldownUntil = &until
					deadline = "2026-10-23T01:02:03.123456789Z"
				}
				f, queries := newRuntimeBarrierProjectionHandlerFixture(t, projection)
				response := httptest.NewRecorder()

				f.raw.ServeHTTP(response, runtimeBarrierProjectionHandlerRequest(f, nil))

				payload := runtimeBarrierProjectionHandlerPayload(t, response)
				raw, present := payload["runtime_recovery"]
				require.True(t, present, "an available projection must reach the real Agent handler response")
				var wire map[string]any
				require.NoError(t, json.Unmarshal(raw, &wire))
				require.Len(t, wire, 9, "recovery exposes only the frozen management fields")
				require.Equal(t, map[string]any{
					"barrier_id": projection.BarrierID, "reason": "runtime_barrier_required",
					"runtime_revision": "rtv_projection_1", "policy_revision": float64(7),
					"mode": mode, "cooldown_ms": float64(60000),
					"rebuild_request_id": projection.RebuildRequestID, "notification_id": projection.NotificationID,
					"cooldown_until": deadline,
				}, wire)
				require.Equal(t, "barrier-e\u0301-\x00-🧪", wire["barrier_id"], "opaque identity must not be normalized or truncated")
				require.Equal(t, "org-1", queries.organizationID)
				require.Equal(t, "agent-1", queries.agentID)
				require.Equal(t, projection, queries.agent.RuntimeRecovery)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryProjectionHandlerOmitsAbsentFieldAndPreservesAgentResponse(t *testing.T) {
	f, queries := newRuntimeBarrierProjectionHandlerFixture(t, nil)
	legacyResponse := httptest.NewRecorder()
	f.raw.ServeHTTP(legacyResponse, runtimeBarrierProjectionHandlerRequest(f, nil))
	legacy := runtimeBarrierProjectionHandlerPayload(t, legacyResponse)
	require.NotContains(t, legacy, "runtime_recovery", "absence is omitted rather than encoded as null or default state")
	var agent agentResponse
	require.NoError(t, json.Unmarshal(legacyResponse.Body.Bytes(), &agent))
	require.Equal(t, "agent-1", agent.AgentID)
	require.Equal(t, "org-1", agent.OrganizationID)
	require.Equal(t, "user-1", agent.OwnerUserID)
	require.Equal(t, int64(9), agent.AggregateSequence)
	require.Equal(t, "spec-3", agent.AgentSpecRevision)
	require.Equal(t, "execution-4", agent.ExecutableExecutionRevision)
	require.NotNil(t, agent.Configuration)
	require.Equal(t, "Research", agent.Configuration.Template.Name)
	require.Equal(t, "test-model", agent.Configuration.ModelProfile.Model.Model)
	require.NotNil(t, agent.Runtime)
	require.Equal(t, "rtv_projection_1", agent.Runtime.RuntimeRevision)

	queries.agent.RuntimeRecovery = runtimeBarrierProjectionHandlerProjection(t)
	withRecovery := httptest.NewRecorder()
	f.raw.ServeHTTP(withRecovery, runtimeBarrierProjectionHandlerRequest(f, nil))
	current := runtimeBarrierProjectionHandlerPayload(t, withRecovery)
	require.Contains(t, current, "runtime_recovery")
	delete(current, "runtime_recovery")
	require.Equal(t, legacy, current, "adding recovery must preserve every existing Agent response field")
}

func TestRuntimeBarrierRecoveryProjectionHandlerRetainsExistingScopeAndAdministratorGate(t *testing.T) {
	now := time.Now().Unix()
	for _, scenario := range []struct {
		name, code string
		status     int
		claims     map[string]any
		change     func(*businessFixture, *http.Request)
	}{
		{name: "missing-workload", status: 401, code: "service_unauthenticated", change: func(_ *businessFixture, request *http.Request) { request.Header.Del(serviceauth.Header) }},
		{name: "missing-CCT", status: 401, code: "caller_context_required", change: func(_ *businessFixture, request *http.Request) { request.Header.Del(callercontext.Header) }},
		{name: "expired-CCT", status: 401, code: "caller_context_invalid", claims: map[string]any{"iat": now - 180, "exp": now - 120}},
		{name: "ordinary-owner", status: 403, code: "forbidden", claims: map[string]any{"sub": "user-1", "sys_role": "user", "org_role": "member"}},
		{name: "cross-organization", status: 403, code: "organization_mismatch", claims: map[string]any{"org": "other-org"}},
		{name: "cross-Agent", status: 401, code: "caller_context_invalid", claims: map[string]any{"agt": "other-agent"}},
		{name: "foreign-workload", status: 403, code: "caller_not_allowed", change: func(f *businessFixture, request *http.Request) {
			request.Header.Set(serviceauth.Header, "Bearer "+f.tokens["agent-ui"])
			caller, err := f.security.Authentication.Authorize(request, []string{"agent-ui"})
			require.NoError(t, err)
			require.Equal(t, "agent-ui", caller)
		}},
		{name: "missing-organization", status: 400, code: "invalid_request", change: func(_ *businessFixture, request *http.Request) { request.URL.RawQuery = "" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f, queries := newRuntimeBarrierProjectionHandlerFixture(t, runtimeBarrierProjectionHandlerProjection(t))
			request := runtimeBarrierProjectionHandlerRequest(f, scenario.claims)
			if scenario.change != nil {
				scenario.change(f, request)
			}
			response := httptest.NewRecorder()

			f.raw.ServeHTTP(response, request)

			require.Equal(t, scenario.status, response.Code, response.Body.String())
			var failure errorResponse
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &failure))
			require.Equal(t, scenario.code, failure.Code)
			require.False(t, failure.Retryable)
			require.Empty(t, queries.agentID, "neither scoped nor unscoped Agent query may run")
			require.Empty(t, queries.organizationID)
			require.Zero(t, queries.listCalls)
			require.Equal(t, application.ListWorkspaceAgentsInput{}, queries.workspaceInput)
			require.NotContains(t, response.Body.String(), "runtime_recovery")
			for _, credential := range []string{request.Header.Get(serviceauth.Header), request.Header.Get(callercontext.Header), "projection-handler-cookie"} {
				if credential != "" {
					require.NotContains(t, response.Body.String(), credential)
				}
			}
		})
	}
}

func newRuntimeBarrierProjectionHandlerFixture(t *testing.T, projection *ports.RuntimeBarrierRecoveryProjection) (*businessFixture, *agentQueryServiceStub) {
	t.Helper()
	now := time.Date(2026, time.October, 23, 0, 0, 0, 0, time.UTC)
	queries := &agentQueryServiceStub{agent: application.AgentView{
		RuntimeRecovery: projection,
		AgentID:         "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Research Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, AccessRevision: "access-1",
		AgentSpecRevisionID: "spec-3", ExecutionRevisionID: "execution-4", LastSuccessfulExecutionRevisionID: "execution-2",
		RuntimeRevision: "rtv_projection_1", AggregateSequence: 9, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
		Configuration: &application.AgentConfigurationView{
			TemplateID: "template-1", TemplateRevision: 2, TemplateName: "Research",
			ModelProfileID: "model-1", ModelProfileRevisionID: "model-revision-4", ModelProfileRevision: 4, ModelProfileName: "Test model",
			Model:            domain.ModelSpec{Model: "test-model", ContextWindow: 64000, MaxOutputTokens: 4096},
			MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1,
			Runtime: domain.RuntimeSpecInput{ImageRef: "antnest/runtime:test"},
		},
	}}
	f := newAuthenticationFixture(t)
	var err error
	f.raw, err = NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	require.NoError(t, err)
	return f, queries
}

func runtimeBarrierProjectionHandlerProjection(t *testing.T) *ports.RuntimeBarrierRecoveryProjection {
	t.Helper()
	barrierID := "barrier-e\u0301-\x00-🧪"
	requestID, err := ports.RuntimeBarrierRecoveryRequestID("org-1", "agent-1", barrierID)
	require.NoError(t, err)
	notificationID, err := ports.RuntimeBarrierNotificationID("org-1", "agent-1", barrierID)
	require.NoError(t, err)
	return &ports.RuntimeBarrierRecoveryProjection{
		BarrierID: barrierID, Reason: ports.ExecutionRuntimeBarrierRequired, RuntimeRevision: "rtv_projection_1",
		PolicyRevision: 7, Mode: "notify", CooldownMS: 60000,
		RebuildRequestID: requestID, NotificationID: notificationID,
	}
}

func runtimeBarrierProjectionHandlerRequest(f *businessFixture, overrides map[string]any) *http.Request {
	f.t.Helper()
	claims := map[string]any{"agt": "agent-1"}
	for key, value := range overrides {
		claims[key] = value
	}
	request := httptest.NewRequest(http.MethodGet, runtimeBarrierProjectionHandlerPath, nil)
	request.Header.Set(serviceauth.Header, "Bearer "+f.tokens["admin-console"])
	request.Header.Set(callercontext.Header, f.sign(claims))
	request.Header.Set("X-Antnest-System-Role", "admin")
	request.Header.Set("X-Antnest-Organization-ID", "forged-org")
	request.Header.Set("Cookie", "projection-handler-cookie")
	return request
}

func runtimeBarrierProjectionHandlerPayload(t *testing.T, response *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	var payload map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	return payload
}
