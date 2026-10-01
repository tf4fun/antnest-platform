package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/server"
	"go.opentelemetry.io/otel/trace"
)

func agentAuthorizationCommand(agent ports.AgentRecord) ports.SetAgentAuthorization {
	return ports.SetAgentAuthorization{OrganizationID: agent.OrganizationID,
		Query:            ports.AgentOwnerScope{AgentID: agent.AgentID, PrincipalID: agent.OwnerUserID, ExpectedAccessRevision: agent.AccessRevision},
		ExpectedRevision: 1, OwnerRevocationSequence: agent.OwnerAuthorizationSequence,
		Authorization: domain.Authorization{Mode: domain.AuthorizationApprove, ToolRules: []domain.ToolRule{}},
		EventID:       "default-authorization-event", Now: time.Now().UTC()}
}

func TestAgentConfigurationHTTPCommitsDefaultAuditAndPublication(t *testing.T) {
	repository, base := identityTestRepository(t)
	identity := &offboardingIdentity{principal: ports.IdentityPrincipal{UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, MembershipID: "member", Active: true}}
	service := application.NewAgentConfigurationService(repository, identity, offboardingClock{})
	unused := &unusedCatalogDependencies{}
	boundary, err := server.NewHandler(nilCatalog{}, unused, service, unused, unused, unused, repository.Ping)
	require.NoError(t, err)
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	hints := 0
	WithExecutionChangeObserver(func(_ context.Context, organizationID string) {
		hints++
		require.Equal(t, base.Agent.OrganizationID, organizationID)
	})(repository)
	input := application.SetAgentAuthorizationInput{RequestID: "set-default", AgentID: base.Agent.AgentID,
		PrincipalID: base.Agent.OwnerUserID, ExpectedAccessRevision: base.Agent.AccessRevision, ExpectedAuthorizationRevision: 1,
		Authorization: domain.Authorization{Mode: domain.AuthorizationChat, ToolRules: []domain.ToolRule{}}}
	body, err := json.Marshal(input)
	require.NoError(t, err)
	parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}})
	for _, status := range []int{http.StatusOK, http.StatusConflict} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/rpc/agent-controller/set-agent-authorization", strings.NewReader(string(body)))
		boundary.ServeHTTP(response, request.WithContext(trace.ContextWithSpanContext(t.Context(), parent)))
		require.Equal(t, status, response.Code, response.Body.String())
	}
	require.Equal(t, 1, hints)
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Equal(t, input.Authorization, after.Agents[0].Authorization)
	require.Equal(t, int64(2), after.Agents[0].AuthorizationRevision)
	agent, err := repository.GetAgent(t.Context(), base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, base.Agent.AggregateSequence+1, agent.AggregateSequence)
	var count int
	var traceID, actor string
	require.NoError(t, repository.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_controller.agent_events WHERE agent_id=$1 AND event_type=$2`, base.Agent.AgentID, ports.EventAgentAuthorizationUpdated).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, repository.pool.QueryRow(t.Context(), `SELECT trace_id, data->>'actor_principal_id' FROM agent_controller.agent_events WHERE agent_id=$1 AND event_type=$2`, base.Agent.AgentID, ports.EventAgentAuthorizationUpdated).Scan(&traceID, &actor))
	require.Equal(t, parent.TraceID().String(), traceID)
	require.Equal(t, base.Agent.OwnerUserID, actor)
	assertManagementOnlySchema(t, repository)
}

type nilCatalog struct{ server.CatalogService }

func TestAgentConfigurationTransactionRechecksOwnershipAndBindings(t *testing.T) {
	for _, test := range []struct {
		name, query  string
		value        any
		currentProof bool
	}{
		{"owner", `WITH changed AS (UPDATE agent_controller.agents SET owner_user_id=$2 WHERE id=$1 RETURNING id)
UPDATE agent_controller.agent_access_bindings SET principal_id=$2 WHERE agent_id IN (SELECT id FROM changed)`, "foreign-owner", true},
		{"organization", `UPDATE agent_controller.agents SET organization_id=$2 WHERE id=$1`, "foreign-org", false},
		{"access revision", `WITH changed AS (UPDATE agent_controller.agents SET access_revision=$2 WHERE id=$1 RETURNING id)
UPDATE agent_controller.agent_access_bindings SET access_revision=$2 WHERE agent_id IN (SELECT id FROM changed)`, "new-access", true},
		{"missing binding", `DELETE FROM agent_controller.agent_access_bindings WHERE agent_id=$1 AND $2::boolean`, true, false},
		{"inactive binding", `UPDATE agent_controller.agent_access_bindings SET active=$2 WHERE agent_id=$1`, false, false},
		{"deleted", `UPDATE agent_controller.agents SET desired_state=$2 WHERE id=$1`, "deleted", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository, base := identityTestRepository(t)
			command := agentAuthorizationCommand(base.Agent)
			_, err := repository.pool.Exec(t.Context(), test.query, base.Agent.AgentID, test.value)
			require.NoError(t, err)
			hints := 0
			WithExecutionChangeObserver(func(context.Context, string) { hints++ })(repository)
			_, err = repository.SetAgentAuthorization(t.Context(), command)
			require.ErrorIs(t, err, ports.ErrAgentAccessDenied)
			require.Zero(t, hints)
			var revision int64
			err = repository.pool.QueryRow(t.Context(), "SELECT authorization_revision FROM agent_controller.agents WHERE id=$1", base.Agent.AgentID).Scan(&revision)
			require.NoError(t, err)
			require.Equal(t, int64(1), revision)
			if test.currentProof {
				current, err := repository.GetAgent(t.Context(), base.Agent.AgentID)
				require.NoError(t, err)
				_, err = repository.SetAgentAuthorization(t.Context(), agentAuthorizationCommand(current))
				require.NoError(t, err, "a matching owner/access revision must succeed with its active binding")
			}
		})
	}
}

func TestAgentConfigurationWatermarkIsScopedToOwnerAndOrganization(t *testing.T) {
	repository, base := identityTestRepository(t)
	for index, event := range []ports.PrincipalRevocation{
		{Sequence: 1, UserID: "another-owner", Reason: "user_deactivated", OccurredAt: time.Now().UTC()},
		{Sequence: 2, UserID: base.Agent.OwnerUserID, OrganizationID: "another-org", Reason: "membership_deactivated", OccurredAt: time.Now().UTC()},
	} {
		require.NoError(t, repository.ApplyIdentityRevocation(t.Context(), int64(index), event, ""))
	}
	_, err := repository.SetAgentAuthorization(t.Context(), agentAuthorizationCommand(base.Agent))
	require.NoError(t, err)
}

func TestAgentConfigurationConcurrentCASAndRollback(t *testing.T) {
	repository, base := identityTestRepository(t)
	var hints atomic.Int64
	WithExecutionChangeObserver(func(context.Context, string) { hints.Add(1) })(repository)
	command := agentAuthorizationCommand(base.Agent)
	results := make(chan error, 2)
	for range 2 {
		go func() { _, err := repository.SetAgentAuthorization(t.Context(), command); results <- err }()
	}
	errors := []error{<-results, <-results}
	if errors[0] != nil {
		errors[0], errors[1] = errors[1], errors[0]
	}
	require.NoError(t, errors[0])
	require.ErrorIs(t, errors[1], ports.ErrConcurrentChange)
	require.Equal(t, int64(1), hints.Load())
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	command.ExpectedRevision = 2
	// Reusing the committed event ID forces the event append to fail after UPDATE.
	_, err = repository.SetAgentAuthorization(t.Context(), command)
	require.Error(t, err)
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	require.Equal(t, int64(1), hints.Load())
}

func TestAgentConfigurationRejectsOldProofBeforeRevocationConsumption(t *testing.T) {
	repository := providerTestRepository(t)
	available, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	disabled := seedDisabledAgentForEnable(t, t.Context(), repository, available)
	stale := agentAuthorizationCommand(disabled)
	identity := &offboardingIdentity{principal: ports.IdentityPrincipal{UserID: disabled.OwnerUserID,
		OrganizationID: disabled.OrganizationID, MembershipID: "member", Active: true, LastRevocationSequence: 5}}
	lifecycle := newIntegratedLifecycleService(repository, repository, nil, nil, offboardingClock{}, application.WithIdentityDirectory(identity), application.WithLifecycleExecution(testLifecycleExecution(repository)))
	_, err := lifecycle.EnableAgent(t.Context(), application.EnableAgentInput{RequestID: "enable-new-proof", AgentID: disabled.AgentID})
	require.NoError(t, err)
	current, err := repository.GetAgent(t.Context(), disabled.AgentID)
	require.NoError(t, err)
	require.Equal(t, int64(5), current.OwnerAuthorizationSequence)
	require.Equal(t, stale.Query.ExpectedAccessRevision, current.AccessRevision)
	cursor, err := repository.GetIdentityRevocationCursor(t.Context())
	require.NoError(t, err)
	require.Zero(t, cursor, "the receipt worker has not consumed the revocation")
	before, err := repository.ReadExecutionSource(t.Context(), current.OrganizationID)
	require.NoError(t, err)
	hints := 0
	WithExecutionChangeObserver(func(context.Context, string) { hints++ })(repository)
	_, err = repository.SetAgentAuthorization(t.Context(), stale)
	require.ErrorIs(t, err, ports.ErrAgentAccessDenied)
	after, err := repository.ReadExecutionSource(t.Context(), current.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	require.Zero(t, hints)
	stale.OwnerRevocationSequence = 5
	_, err = repository.SetAgentAuthorization(t.Context(), stale)
	require.NoError(t, err)
	require.Equal(t, 1, hints)
}

func TestExecutionPublicationHonorsCurrentOwnerBinding(t *testing.T) {
	for _, test := range []struct {
		name, query string
		allowed     bool
	}{
		{"active", "", true},
		{"inactive", "UPDATE agent_controller.agent_access_bindings SET active=false WHERE agent_id=$1", false},
		{"missing", "DELETE FROM agent_controller.agent_access_bindings WHERE agent_id=$1", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository, base, _ := executionConfigurationRepository(t)
			before := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
			if test.query != "" {
				_, err := repository.pool.Exec(t.Context(), test.query, base.Agent.AgentID)
				require.NoError(t, err)
			}
			after := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
			agent := publishedAgent(t, repository, base.Agent)
			require.Equal(t, test.allowed, agent.AcceptingRuns)
			if test.allowed {
				require.Equal(t, []string{base.Agent.OwnerUserID}, agent.PrincipalIDs)
			} else {
				require.Empty(t, agent.PrincipalIDs)
			}
			require.Equal(t, before.Providers, after.Providers, "owner access does not delete organization-shared credentials")
			require.Equal(t, before.Models, after.Models)
		})
	}
}
