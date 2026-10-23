package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentReadinessFirstReadyRequiresACKOfReopenedExecutablePublication(t *testing.T) {
	parent, repo, _ := controllerTestConnection(t)
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	create, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, create,
		"execution-readiness-reopen", "readiness-reopen-process", "http://readiness-reopen:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	bound, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	current := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.True(t, current.ExecutionReady())
	require.True(t, publishedAgent(t, repo, base.Agent).AcceptingRuns)
	history := agentReadinessEvents(t, ctx, repo, base.Agent)
	boundEvents := agentReadinessEventsOfType(history, ports.EventRuntimeBound)
	require.Len(t, boundEvents, 1)
	agentReadinessAssertProof(t, boundEvents[0], input, bound.Revision, 0)
	require.Empty(t, agentReadinessEventsOfType(history, ports.EventAgentReady))
	require.Nil(t, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID).ReadyAt)

	// The first ACK is deliberately for a later, closed snapshot. It numerically
	// covers the original binding threshold, not the reopened executable revision.
	_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: current.AggregateSequence,
		Inspection: ports.RuntimeInspection{
			AgentID: current.AgentID, RuntimeRevision: current.RuntimeRevision,
			RuntimeExecutionID: current.RuntimeExecutionID, MCPEndpoint: current.RuntimeMCPEndpoint,
			LifecycleState: "provisioned", Phase: "running", Health: "unhealthy",
			ObservedAt: input.Execution.PublishedAt.Add(time.Second),
		},
	})
	require.NoError(t, err)
	closedAgent := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
	require.Equal(t, domain.RuntimeUnhealthy, closedAgent.RuntimeState)
	require.Equal(t, input.Execution.ID, closedAgent.ExecutionRevisionID)
	require.False(t, publishedAgent(t, repo, base.Agent).AcceptingRuns)
	closed, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, closed.Revision, bound.Revision)
	closingACK := ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: closed.Revision,
	}
	require.NoError(t, repo.RecordExecutionApplied(ctx, closingACK))
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady), "ACK of a closed snapshot cannot produce the first ready event")
	require.Nil(t, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID).ReadyAt)
	closedApplied, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, closed.Revision, closedApplied.Revision)
	require.Equal(t, closed.Revision, closedApplied.AppliedRevision)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")

	closedAgent, err = repo.GetAgent(ctx, base.Agent.AgentID)
	require.NoError(t, err)
	_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: closedAgent.AggregateSequence,
		Inspection: ports.RuntimeInspection{
			AgentID: closedAgent.AgentID, RuntimeRevision: closedAgent.RuntimeRevision,
			RuntimeExecutionID: closedAgent.RuntimeExecutionID, MCPEndpoint: closedAgent.RuntimeMCPEndpoint,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy",
			ObservedAt: input.Execution.PublishedAt.Add(2 * time.Second),
		},
	})
	require.NoError(t, err)
	reopened, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, reopened.Revision, closed.Revision)
	require.Equal(t, closed.Revision, reopened.AppliedRevision)
	healthy := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.True(t, healthy.ExecutionReady())
	require.Equal(t, domain.RuntimeAvailable, healthy.RuntimeState)
	require.Equal(t, input.Execution.ID, healthy.ExecutionRevisionID)
	require.Equal(t, input.Execution.RuntimeRevision, healthy.RuntimeRevision)
	require.Equal(t, input.Execution.RuntimeExecutionID, healthy.RuntimeExecutionID)
	beforeACK := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
	require.Equal(t, reopened.Revision, beforeACK.Revision)
	require.Len(t, beforeACK.Agents, 1)
	require.True(t, beforeACK.Agents[0].AcceptingRuns, "reopened executable publication must not wait for its own ACK")
	require.NotNil(t, beforeACK.Agents[0].ExecutionRevision)
	require.Equal(t, input.Execution.ID, *beforeACK.Agents[0].ExecutionRevision)
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))

	require.NoError(t, repo.RecordExecutionApplied(ctx, closingACK))
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady), "replaying the old closing ACK after reopening must not manufacture ready")
	require.Nil(t, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID).ReadyAt)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.Equal(t, beforeACK, currentExecutionSnapshot(t, repo, base.Agent.OrganizationID))

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: reopened.Revision,
	}))
	readyAgent := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	require.Equal(t, input.Execution.ID, readyAgent.ExecutionRevisionID)
	finalEvents := agentReadinessEvents(t, ctx, repo, base.Agent)
	readyEvents := agentReadinessEventsOfType(finalEvents, ports.EventAgentReady)
	require.Len(t, readyEvents, 1, "only the ACK covering reopened execution may produce the first ready event")
	require.Equal(t, boundEvents, agentReadinessEventsOfType(finalEvents, ports.EventRuntimeBound))
	proof := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, input.Execution.ID, proof.ExecutionRevisionID)
	require.NotNil(t, proof.ReadyAt)
	require.GreaterOrEqual(t, proof.ReadyAfterRevision, bound.Revision)
	require.LessOrEqual(t, proof.ReadyAfterRevision, reopened.Revision)
	require.Equal(t, reopened.Revision, proof.AppliedRevision)
	agentReadinessAssertProof(t, readyEvents[0], input, proof.ReadyAfterRevision, reopened.Revision)
	covered, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, reopened.Revision, covered.Revision)
	require.Equal(t, reopened.Revision, covered.AppliedRevision)
	require.Equal(t, beforeACK, currentExecutionSnapshot(t, repo, base.Agent.OrganizationID), "ACK must not republish or rewrite executable configuration")

	for _, acknowledgement := range []ports.ExecutionAcknowledgement{closingACK, {
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: reopened.Revision,
	}} {
		require.NoError(t, repo.RecordExecutionApplied(ctx, acknowledgement))
	}
	require.Equal(t, finalEvents, agentReadinessEvents(t, ctx, repo, base.Agent))
	require.Equal(t, proof, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID))
}
