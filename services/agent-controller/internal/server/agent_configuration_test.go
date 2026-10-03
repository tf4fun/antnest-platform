package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type agentConfigurationServiceStub struct {
	input                       application.SetAgentAuthorizationInput
	err                         error
	synchronization             *application.ExecutionSynchronizationState
	synchronizationOrganization string
}

func (service *agentConfigurationServiceStub) GetExecutionSynchronization(_ context.Context, organizationID string) (application.ExecutionSynchronizationView, error) {
	service.synchronizationOrganization = organizationID
	return application.ExecutionSynchronizationView{OrganizationID: organizationID, Synchronization: service.synchronization}, service.err
}

func (service *agentConfigurationServiceStub) SetAgentAuthorization(_ context.Context, input application.SetAgentAuthorizationInput) (int64, error) {
	service.input = input
	return input.ExpectedAuthorizationRevision + 1, service.err
}

func TestAgentAuthorizationRPCUsesManagementDependency(t *testing.T) {
	t.Parallel()
	configuration := &agentConfigurationServiceStub{}
	boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{},
		configuration, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.NoError(t, err)
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/rpc/agent-controller/set-agent-authorization",
		strings.NewReader(`{"request_id":"default","agent_id":"agent","principal_id":"owner","expected_access_revision":"access","expected_authorization_revision":1,"authorization":{"mode":"approve","tool_rules":[]}}`)))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.JSONEq(t, `{"authorization_revision":2}`, response.Body.String())
	require.Equal(t, "owner", configuration.input.PrincipalID)
	require.Equal(t, "agent", configuration.input.AgentID)
}

func TestAgentConfigurationDependencyRequired(t *testing.T) {
	t.Parallel()
	_, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, nil,
		&agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	require.ErrorContains(t, err, "agent configuration service")
}

func TestAgentConfigurationErrorContract(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		cause  error
		status int
		code   string
	}{
		{application.ErrAccessDenied, 403, "access_denied"},
		{ports.ErrConcurrentChange, 409, "configuration_conflict"},
		{application.ErrAgentNotFound, 404, "agent_not_found"},
		{application.ErrInvalidInput, 400, "invalid_request"},
		{application.ErrDependencyUnavailable, 503, "dependency_unavailable"},
		{context.DeadlineExceeded, 503, "dependency_unavailable"},
		{ports.ErrExecutionCapacityExceeded, 409, "execution_configuration_capacity_exceeded"},
	} {
		t.Run(test.code, func(t *testing.T) {
			boundary, err := newBusinessHandler(t, &catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{err: test.cause}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/rpc/agent-controller/set-agent-authorization",
				strings.NewReader(`{"request_id":"default","agent_id":"agent","principal_id":"owner","expected_access_revision":"access","expected_authorization_revision":1,"authorization":{"mode":"auto","tool_rules":[]}}`)))
			require.Equal(t, test.status, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), `"code":"`+test.code+`"`)
		})
	}
}
