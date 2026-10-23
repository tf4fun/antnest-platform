package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentCurrentReadinessGetAndListFollowCurrentBindingACK(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-current-readiness", "current-readiness-process", "http://current-readiness:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	publication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, publication.Revision, int64(1))
	beforeACK := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
	require.Len(t, beforeACK.Agents, 1)
	require.True(t, beforeACK.Agents[0].AcceptingRuns, "complete binding publication cannot wait for its own ACK")
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: publication.Revision - 1,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: publication.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	require.Len(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady), 1)
	require.Equal(t, beforeACK, currentExecutionSnapshot(t, repo, base.Agent.OrganizationID), "current readiness must not rewrite an already executable publication")
	after, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, publication.Revision, after.Revision)
	require.Equal(t, publication.Revision, after.AppliedRevision)
}

func TestAgentCurrentReadinessHistoricalV1ReadyNeedsCurrentBootstrapACK(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := agentReadinessSeedLegacyBinding(t, ctx, repo)
	before, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	history := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
	require.Len(t, history, 1)
	require.Equal(t, 1, history[0].SchemaVersion)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: before.Revision,
	}))
	bootstrapped, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, bootstrapped.Revision)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.Equal(t, history, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: bootstrapped.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	ready := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
	require.Len(t, ready, 2)
	require.Equal(t, history[0], ready[0])
	require.Equal(t, 2, ready[1].SchemaVersion)
}

func TestAgentCurrentReadinessCurrentClosureOverridesHistoricalProof(t *testing.T) {
	for _, closure := range []string{"Identity revocation", "Disable admission"} {
		t.Run(closure, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
			op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
			require.NoError(t, err)
			input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-current-closure", "current-closure-process", "http://current-closure:8091/mcp")
			changed, err := repo.PublishRuntimeBinding(ctx, input)
			require.NoError(t, err)
			require.True(t, changed)
			publication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
			require.NoError(t, err)
			require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
				OrganizationID: base.Agent.OrganizationID, AppliedRevision: publication.Revision,
			}))
			agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
			proof := agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, input.Execution.ID)
			history := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
			require.Len(t, history, 1)
			if closure == "Identity revocation" {
				cursor, err := repo.GetIdentityRevocationCursor(ctx)
				require.NoError(t, err)
				require.NoError(t, repo.ApplyIdentityRevocation(ctx, cursor, ports.PrincipalRevocation{
					Sequence: cursor + 1, UserID: base.Agent.OwnerUserID, OrganizationID: base.Agent.OrganizationID,
					Reason: "membership_deactivated", OccurredAt: time.Now().UTC(),
				}, ""))
			} else {
				current, err := repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
				require.NoError(t, err)
				begin := disableBegin(current, "disable-current-readiness", strings.Repeat("d", 64), time.Now().UTC())
				state, replayed, err := repo.BeginAgentDisable(ctx, begin)
				require.NoError(t, err)
				require.False(t, replayed)
				require.Equal(t, domain.DesiredDisabled, state.Agent.DesiredState)
			}
			agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
			closed, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
			require.NoError(t, err)
			require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
				OrganizationID: base.Agent.OrganizationID, AppliedRevision: closed.Revision,
			}))
			agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
			require.Equal(t, proof, agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, input.Execution.ID), "closing execution must retain its historical proof")
			require.Equal(t, history, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))
			require.False(t, publishedAgent(t, repo, base.Agent).AcceptingRuns)
		})
	}
}

func TestAgentCurrentReadinessReplacementCannotInheritOldReadyProof(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, seed := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	original := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-current-original", "current-original-process", "http://current-original:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, original)
	require.NoError(t, err)
	require.True(t, changed)
	oldPublication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: oldPublication.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	oldProof := agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, original.Execution.ID)
	current, err := repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
	require.NoError(t, err)
	begin := catalogRebuildInput(t, current, seed.Revision, seed.Model.Revision)
	_, replayed, err := repo.BeginAgentRebuild(ctx, begin)
	require.NoError(t, err)
	require.False(t, replayed)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
	// These helpers drive the real repository drain/advance/publish APIs with
	// synthetic Runtime results; no replacement binding or proof is hand-inserted.
	catalogPublishRebuild(t, repo, begin)
	pending := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.NotEqual(t, original.Execution.RuntimeRevision, pending.RuntimeRevision)
	require.Empty(t, pending.ExecutionRevisionID)
	op, err = repo.GetLifecycleOperation(ctx, begin.Operation.RequestID)
	require.NoError(t, err)
	replacement := runtimeBindingInput(t, ctx, repo, pending, op, "execution-current-replacement", "current-replacement-process", "http://current-replacement:8091/mcp")
	changed, err = repo.PublishRuntimeBinding(ctx, replacement)
	require.NoError(t, err)
	require.True(t, changed)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	newPublication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, newPublication.Revision, oldPublication.Revision)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: oldPublication.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.Equal(t, oldProof, agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, original.Execution.ID))
	var replacementReady bool
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT ready_at IS NOT NULL FROM agent_controller.agent_runtime_readiness
WHERE agent_id=$1 AND execution_revision_id=$2`, base.Agent.AgentID, replacement.Execution.ID).Scan(&replacementReady))
	require.False(t, replacementReady)
	beforeACK := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
	require.Len(t, beforeACK.Agents, 1)
	require.True(t, beforeACK.Agents[0].AcceptingRuns)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: newPublication.Revision,
	}))
	readyAgent := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	require.Equal(t, replacement.Execution.ID, readyAgent.ExecutionRevisionID)
	require.Equal(t, oldProof, agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, original.Execution.ID))
	require.Equal(t, beforeACK, currentExecutionSnapshot(t, repo, base.Agent.OrganizationID))
	ready := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
	require.Len(t, ready, 2)
	require.Equal(t, original.Execution.ID, ready[0].Data["execution_revision_id"])
	require.Equal(t, replacement.Execution.ID, ready[1].Data["execution_revision_id"])
}

func agentCurrentReadinessGetAndList(t *testing.T, ctx context.Context, repo *Repository, scope ports.AgentRecord, want string) ports.AgentRecord {
	t.Helper()
	agent, err := repo.GetAgent(ctx, scope.AgentID)
	require.NoError(t, err)
	require.Equal(t, want, agent.CurrentReadiness(), "GetAgent must project current persisted readiness")
	listed, err := repo.ListAgents(ctx, ports.AgentQuery{OrganizationID: scope.OrganizationID, OwnerUserID: scope.OwnerUserID, Limit: 10})
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, scope.AgentID, listed[0].AgentID)
	require.Equal(t, want, listed[0].CurrentReadiness(), "ListAgents must agree with GetAgent")
	require.Equal(t, agent.ExecutionRevisionID, listed[0].ExecutionRevisionID)
	require.Equal(t, agent.AgentSpecRevisionID, listed[0].AgentSpecRevisionID)
	return agent
}

func agentCurrentReadinessProofSnapshot(t *testing.T, ctx context.Context, repo *Repository, agentID, executionID string) string {
	t.Helper()
	var proof string
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT (to_jsonb(proof)-'reopen_after_revision')::text FROM agent_controller.agent_runtime_readiness proof
WHERE agent_id=$1 AND execution_revision_id=$2`, agentID, executionID).Scan(&proof))
	return proof
}

func TestAgentCurrentReadinessPreservedFailureBecomesReadyAfterFreshHealthAndACK(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, seed := seedConfiguredAgentForTest(t, ctx, repo, false)
	create, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	original := runtimeBindingInput(t, ctx, repo, base.Agent, create,
		"execution-preserved-readiness", "preserved-readiness-process", "http://preserved-readiness:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, original)
	require.NoError(t, err)
	require.True(t, changed)
	published, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: published.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	originalProof := agentCurrentReadinessProofSnapshot(t, ctx, repo, base.Agent.AgentID, original.Execution.ID)
	originalReadyEvents := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
	require.Len(t, originalReadyEvents, 1)

	current, err := repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
	require.NoError(t, err)
	begin := catalogRebuildInput(t, current, seed.Revision, seed.Model.Revision)
	started, replayed, err := repo.BeginAgentRebuild(ctx, begin)
	require.NoError(t, err)
	require.False(t, replayed)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
	failedAt := begin.Now.Add(time.Second)
	failed, err := repo.FailAgentRebuild(ctx, ports.FailAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint,
		ExpectedAggregateSequence: started.Agent.AggregateSequence,
		Stage:                     domain.PhaseDrain, Code: "run_drain_timeout", Detail: "Run did not settle",
		PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-preserved-readiness-failed", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentBuildFailed,
			OperationRequestID: begin.Operation.RequestID, Data: map[string]any{}, OccurredAt: failedAt,
		},
		Now: failedAt,
	})
	require.NoError(t, err)
	require.Equal(t, domain.OperationFailed, failed.Operation.State)
	require.Equal(t, original.Execution.ID, failed.Agent.ExecutionRevisionID)
	require.Empty(t, failed.Agent.ActiveOperationRequestID)
	require.Equal(t, domain.RuntimeUnknown, failed.Agent.RuntimeState)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "unavailable")
	require.False(t, publishedAgent(t, repo, base.Agent).AcceptingRuns, "preserved source still requires fresh Runtime evidence")
	closedPublication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: closedPublication.Revision,
	}))

	_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: failed.Agent.AggregateSequence,
		Inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: original.Execution.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy",
			RuntimeExecutionID: original.Execution.RuntimeExecutionID,
			MCPEndpoint:        original.Execution.RuntimeMCPEndpoint, ObservedAt: failedAt.Add(time.Second),
		},
	})
	require.NoError(t, err)
	healthy, err := repo.GetAgent(ctx, base.Agent.AgentID)
	require.NoError(t, err)
	require.True(t, healthy.ExecutionReady())
	require.Equal(t, domain.RuntimeAvailable, healthy.RuntimeState)
	require.Equal(t, string(domain.PhaseDrain), healthy.FailureStage)
	require.Equal(t, "run_drain_timeout", healthy.FailureCode)
	require.True(t, publishedAgent(t, repo, healthy).AcceptingRuns)
	currentPublication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, currentPublication.Revision, published.Revision)
	var reopenAfter int64
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT reopen_after_revision FROM agent_controller.agent_runtime_readiness WHERE agent_id=$1 AND execution_revision_id=$2`,
		base.Agent.AgentID, original.Execution.ID).Scan(&reopenAfter))
	require.Equal(t, currentPublication.Revision, reopenAfter)
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: closedPublication.Revision,
	}))
	agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "preparing")
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: currentPublication.Revision,
	}))

	ready := agentCurrentReadinessGetAndList(t, ctx, repo, base.Agent, "ready")
	require.Equal(t, original.Execution.ID, ready.ExecutionRevisionID)
	require.Equal(t, original.Execution.RuntimeRevision, ready.RuntimeRevision)
	require.Equal(t, original.Execution.RuntimeExecutionID, ready.RuntimeExecutionID)
	require.Equal(t, string(domain.PhaseDrain), ready.FailureStage, "historical failure diagnostics must remain visible")
	require.Equal(t, "run_drain_timeout", ready.FailureCode)
	require.Equal(t, originalProof, agentCurrentReadinessProofSnapshot(t, ctx, repo, ready.AgentID, original.Execution.ID))
	require.Equal(t, originalReadyEvents, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, ready), ports.EventAgentReady), "same acknowledged binding must not append a duplicate ready event")
	operation, err := repo.GetLifecycleOperation(ctx, begin.Operation.RequestID)
	require.NoError(t, err)
	require.Equal(t, domain.OperationFailed, operation.State)
	require.Equal(t, "run_drain_timeout", operation.ErrorCode)
}
