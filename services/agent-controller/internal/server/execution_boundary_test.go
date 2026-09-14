package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func TestControllerDoesNotExposeRunExecutionRPC(t *testing.T) {
	t.Parallel()
	boundary, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{},
		&networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.NoError(t, err)
	for _, method := range []string{
		"resolve-agent-access", "get-session-configuration", "acquire-run", "resolve-credential", "finish-run",
	} {
		t.Run(method, func(t *testing.T) {
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/rpc/agent-controller/"+method, strings.NewReader(`{}`)))
			require.Equal(t, http.StatusNotFound, response.Code, "execution RPC must not be registered")
		})
	}
}

func TestWorkspaceListTimeoutIsDependencyFailure(t *testing.T) {
	t.Parallel()
	boundary, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{},
		&agentConfigurationServiceStub{}, &agentQueryServiceStub{err: context.DeadlineExceeded},
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.NoError(t, err)
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/rpc/agent-controller/list-workspace-agents",
		strings.NewReader(`{"request_id":"list","organization_id":"org","principal_id":"owner"}`)))
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	require.JSONEq(t, `{"code":"dependency_unavailable","message":"dependency is unavailable","retryable":true}`, response.Body.String())
}

func TestManagementRPCRejectsMalformedAuthorization(t *testing.T) {
	t.Parallel()
	for _, authorization := range []string{
		`{"mode":"auto","tool_rules":[],"unknown":true}`,
		`{"mode":"auto"}`,
		`{"mode":"auto","tool_rules":null}`,
		`{"mode":"auto","tool_rules":[{"source":"agent","source_id":"core","tool_name":"read","decision":"allow","unknown":true}]}`,
	} {
		t.Run(authorization, func(t *testing.T) {
			configuration := &agentConfigurationServiceStub{}
			boundary, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, configuration,
				&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/rpc/agent-controller/set-agent-authorization", strings.NewReader(
					`{"request_id":"defaults","agent_id":"agent","principal_id":"owner","expected_access_revision":"access","expected_authorization_revision":1,"authorization":`+authorization+`}`)))
			require.Equal(t, http.StatusBadRequest, response.Code)
			require.Equal(t, application.SetAgentAuthorizationInput{}, configuration.input)
		})
	}
}

func TestControllerDoesNotExposeWorkspaceExecutionState(t *testing.T) {
	t.Parallel()
	boundary, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{},
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.NoError(t, err)
	for _, suffix := range []string{"state", "state/watch"} {
		t.Run(suffix, func(t *testing.T) {
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet,
				"/internal/workspace/agents/agent-1/"+suffix+"?organization_id=org&principal_id=owner", nil))
			require.Equal(t, http.StatusNotFound, response.Code)
		})
	}
}

func TestWorkspaceListPublishesOnlyManagementMetadata(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		page     application.WorkspaceAgentPage
		expected string
	}{
		{"page", application.WorkspaceAgentPage{Items: []application.WorkspaceAgentView{{AgentID: "agent-1", Name: "Research"}}, NextCursor: "next"},
			`{"agents":[{"agent_id":"agent-1","name":"Research"}],"next_cursor":"next"}`},
		{"empty", application.WorkspaceAgentPage{}, `{"agents":[],"next_cursor":null}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := &agentQueryServiceStub{workspacePage: test.page}
			boundary, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
				&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
				"/rpc/agent-controller/list-workspace-agents",
				strings.NewReader(`{"request_id":"list","organization_id":"org","principal_id":"owner"}`)))
			require.Equal(t, http.StatusOK, response.Code)
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			require.JSONEq(t, test.expected, response.Body.String())
		})
	}
}
