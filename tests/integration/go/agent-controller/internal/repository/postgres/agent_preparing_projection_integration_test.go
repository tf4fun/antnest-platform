package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentPreparingProjectionReasonTransitionsAdvancePublication(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	before := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
	require.Equal(t, "agent_preparing", *before.Agents[0].UnavailableReason)
	observedAt := time.Now().UTC()
	for index, step := range []struct {
		health, reason string
		advance        int64
	}{
		{"unhealthy", "agent_unavailable", 1},
		{"unhealthy", "agent_unavailable", 0},
		{"starting", "agent_preparing", 1},
		{"healthy", "agent_preparing", 0},
	} {
		agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
		require.NoError(t, err)
		_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
			ExpectedAggregateSequence: agent.AggregateSequence,
			Inspection: ports.RuntimeInspection{
				AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
				LifecycleState: "provisioned", Phase: "running", Health: step.health,
				ObservedAt: observedAt.Add(time.Duration(index) * time.Second),
			},
		})
		require.NoError(t, err)
		after := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
		require.Equal(t, step.reason, *after.Agents[0].UnavailableReason)
		require.False(t, after.Agents[0].AcceptingRuns)
		require.Equal(t, before.Revision+step.advance, after.Revision, "a changed preparing reason needs a new immutable snapshot revision")
		if step.advance == 0 {
			require.Equal(t, before, after, "timestamps and health within one preparing state do not republish configuration")
		}
		before = after
	}
}

func TestAgentPreparingProjectionReadExecutionSourceRetainsOwnerGrant(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	source, err := repo.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.Agents, 1)
	pending := source.Agents[0]
	require.Equal(t, base.Agent.AgentID, pending.Agent.AgentID)
	require.Equal(t, domain.AgentCreated, pending.Agent.LifecycleState)
	require.Equal(t, domain.ActivationEnabled, pending.Agent.ActivationState)
	require.Equal(t, domain.DesiredEnabled, pending.Agent.DesiredState)
	require.Equal(t, domain.RuntimeUnknown, pending.Agent.RuntimeState)
	require.True(t, pending.OwnerAccessGranted)
	require.Equal(t, base.ConfiguredSpec.ID, pending.Spec.ID)
	require.Equal(t, pending.Spec.ID, pending.Agent.AgentSpecRevisionID)
	require.NotEmpty(t, pending.Agent.RuntimeRevision)
	require.Empty(t, pending.Agent.ExecutionRevisionID)
	require.Empty(t, pending.Agent.RuntimeExecutionID)
	require.Empty(t, pending.Agent.RuntimeMCPEndpoint)
	require.Empty(t, pending.Agent.ActiveOperationRequestID)
	require.Empty(t, pending.Agent.FailureStage)
	require.Empty(t, pending.Agent.FailureCode)

	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Len(t, snapshot.Agents, 1)
	projection := snapshot.Agents[0]
	require.False(t, projection.AcceptingRuns)
	require.NotNil(t, projection.UnavailableReason)
	require.Equal(t, "agent_preparing", *projection.UnavailableReason)
	require.Equal(t, []string{base.Agent.OwnerUserID}, projection.PrincipalIDs)
	require.NotNil(t, projection.AgentSpecRevision)
	require.Equal(t, pending.Spec.ID, *projection.AgentSpecRevision)
	require.Nil(t, projection.ExecutionRevision)
	require.Nil(t, projection.Runtime)
	require.Equal(t, source.Revision, snapshot.Revision)
}

func TestAgentPreparingProjectionStoredBlockersRemainUnavailable(t *testing.T) {
	for _, blocker := range []string{"runtime observation failure", "Runtime unhealthy", "owner access inactive"} {
		t.Run(blocker, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
			// These fixture-only writes isolate the exact stored fence while
			// leaving the real configured, never-bound Agent and its spec intact.
			switch blocker {
			case "runtime observation failure":
				result, err := repo.pool.Exec(ctx, `UPDATE agent_controller.agents SET failure_stage='runtime_observation'
WHERE id=$1 AND runtime_state='unknown' AND executable_execution_revision_id=''
AND runtime_execution_id='' AND runtime_mcp_endpoint='' AND active_operation_request_id=''`, base.Agent.AgentID)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
			case "Runtime unhealthy":
				result, err := repo.pool.Exec(ctx, `UPDATE agent_controller.agents SET runtime_state='unhealthy'
WHERE id=$1 AND runtime_state='unknown' AND executable_execution_revision_id=''
AND runtime_execution_id='' AND runtime_mcp_endpoint='' AND failure_stage=''`, base.Agent.AgentID)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
			case "owner access inactive":
				result, err := repo.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings SET active=false
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
					base.Agent.AgentID, base.Agent.OwnerUserID, base.Agent.AccessRevision)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
			}
			stored, err := repo.GetAgent(ctx, base.Agent.AgentID)
			require.NoError(t, err)
			require.Equal(t, base.Agent.AgentSpecRevisionID, stored.AgentSpecRevisionID)
			require.Equal(t, base.Agent.RuntimeRevision, stored.RuntimeRevision)
			require.Empty(t, stored.ExecutionRevisionID)
			require.Empty(t, stored.RuntimeExecutionID)
			require.Empty(t, stored.RuntimeMCPEndpoint)
			if blocker == "runtime observation failure" {
				require.Equal(t, domain.RuntimeUnknown, stored.RuntimeState)
				require.Equal(t, "runtime_observation", stored.FailureStage)
			}
			source, err := repo.ReadExecutionSource(ctx, base.Agent.OrganizationID)
			require.NoError(t, err)
			require.Len(t, source.Agents, 1)
			snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
			require.NoError(t, err)
			require.Len(t, snapshot.Agents, 1)
			projection := snapshot.Agents[0]
			require.False(t, projection.AcceptingRuns)
			require.NotNil(t, projection.UnavailableReason)
			require.Equal(t, "agent_unavailable", *projection.UnavailableReason)
			require.Equal(t, stored.FailureStage, source.Agents[0].Agent.FailureStage, "the stored failure fence must survive the production source reader")
			require.Equal(t, stored.RuntimeState, source.Agents[0].Agent.RuntimeState)
			if blocker == "owner access inactive" {
				require.False(t, source.Agents[0].OwnerAccessGranted)
				require.Empty(t, projection.PrincipalIDs)
			} else {
				require.True(t, source.Agents[0].OwnerAccessGranted)
				require.Equal(t, []string{base.Agent.OwnerUserID}, projection.PrincipalIDs)
			}
			require.Nil(t, projection.ExecutionRevision)
			require.Nil(t, projection.Runtime)
		})
	}
}

func TestAgentPreparingProjectionCompleteBindingPublishesBeforeACK(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-preparing-projection", "projection-process", "http://projection-runtime:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	publication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Less(t, publication.AppliedRevision, publication.Revision)
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, publication.Revision, fact.ReadyAfterRevision)
	require.Zero(t, fact.AppliedRevision)
	require.Nil(t, fact.ReadyAt)
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	require.Len(t, agentReadinessEventsOfType(events, ports.EventRuntimeBound), 1)
	require.Empty(t, agentReadinessEventsOfType(events, ports.EventAgentReady))

	source, err := repo.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Len(t, source.Agents, 1)
	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Len(t, snapshot.Agents, 1)
	projection := snapshot.Agents[0]
	require.True(t, projection.AcceptingRuns, "the executable publication enables its own acknowledgement")
	require.Nil(t, projection.UnavailableReason)
	require.Equal(t, []string{base.Agent.OwnerUserID}, projection.PrincipalIDs)
	require.NotNil(t, projection.ExecutionRevision)
	require.Equal(t, input.Execution.ID, *projection.ExecutionRevision)
	require.NotNil(t, projection.Runtime)
	require.Equal(t, input.Execution.RuntimeExecutionID, projection.Runtime.RuntimeExecutionID)
	require.Equal(t, publication.Revision, snapshot.Revision)
	after, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, publication, after, "reading and building a snapshot cannot acknowledge or republish it")
}
