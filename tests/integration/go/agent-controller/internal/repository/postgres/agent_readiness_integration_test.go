package postgres

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentReadinessBindingPublishesBoundProofBeforeAppliedReadiness(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	before, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-readiness-bound", "readiness-process", "http://readiness-runtime:8091/mcp")

	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	after, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	require.NotEqual(t, input.Execution.Revision, after.Revision, "fixture must distinguish the Agent counter from the organization publication revision")
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	bound := agentReadinessEventsOfType(events, ports.EventRuntimeBound)
	require.Len(t, bound, 1)
	require.Empty(t, agentReadinessEventsOfType(events, ports.EventAgentReady), "binding health must not publish readiness before an ACP ACK")
	agentReadinessAssertProof(t, bound[0], input, after.Revision, 0)
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, input.Execution.ID, fact.ExecutionRevisionID)
	require.Equal(t, after.Revision, fact.ReadyAfterRevision)
	require.Zero(t, fact.AppliedRevision)
	require.Nil(t, fact.ReadyAt)

	// ACP must receive an executable binding in this very revision: readiness
	// cannot close publication until the ACK that publication itself enables.
	snapshot := currentExecutionSnapshot(t, repo, base.Agent.OrganizationID)
	require.Equal(t, after.Revision, snapshot.Revision)
	published := publishedAgent(t, repo, base.Agent)
	require.True(t, published.AcceptingRuns)
	require.NotNil(t, published.Runtime)
	require.Equal(t, input.Execution.RuntimeExecutionID, published.Runtime.RuntimeExecutionID)
	require.NotNil(t, published.ExecutionRevision)
	require.Equal(t, input.Execution.ID, *published.ExecutionRevision)
	require.Equal(t, before.AppliedRevision, after.AppliedRevision)

	changed, err = repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.False(t, changed)
	require.Equal(t, events, agentReadinessEvents(t, ctx, repo, base.Agent))
	replayed, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, after, replayed)
}

func TestAgentReadinessACKCoversThresholdExactlyOnce(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-readiness-ack", "readiness-ack-process", "http://readiness-ack:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	state, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, state.Revision, int64(1))

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: state.Revision - 1,
	}))
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady), "a lower organization ACK must not make this binding ready")
	below := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Nil(t, below.ReadyAt)
	require.Zero(t, below.AppliedRevision)

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: state.Revision,
	}))
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	ready := agentReadinessEventsOfType(events, ports.EventAgentReady)
	require.Len(t, ready, 1)
	agentReadinessAssertProof(t, ready[0], input, state.Revision, state.Revision)
	require.Len(t, agentReadinessEventsOfType(events, ports.EventRuntimeBound), 1)
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, state.Revision, fact.ReadyAfterRevision)
	require.Equal(t, state.Revision, fact.AppliedRevision)
	require.NotNil(t, fact.ReadyAt)
	covered, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, state.Revision, covered.Revision, "ACK readiness must not advance the desired publication revision")
	require.Equal(t, state.Revision, covered.AppliedRevision)

	for _, revision := range []int64{state.Revision, state.Revision - 1, state.Revision} {
		require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
			OrganizationID: base.Agent.OrganizationID, AppliedRevision: revision,
		}))
	}
	require.Equal(t, events, agentReadinessEvents(t, ctx, repo, base.Agent))
	require.Equal(t, fact, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID))
	repeated, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, state.Revision, repeated.Revision)
	require.Equal(t, state.Revision, repeated.AppliedRevision)
}

func TestAgentReadinessLegacyACKBootstrapsBeforeNewACKCanProveReady(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, input := agentReadinessSeedLegacyBinding(t, ctx, repo)
	before, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	history := agentReadinessEvents(t, ctx, repo, base.Agent)
	legacyReady := agentReadinessEventsOfType(history, ports.EventAgentReady)
	require.Len(t, legacyReady, 1)
	require.Equal(t, 1, legacyReady[0].SchemaVersion)
	require.True(t, publishedAgent(t, repo, base.Agent).AcceptingRuns)

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: before.Revision,
	}))
	bootstrapped, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, bootstrapped.Revision, "legacy bindings require a new publication carrying their bound proof")
	require.Equal(t, before.Revision, bootstrapped.AppliedRevision)
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	require.Equal(t, legacyReady, agentReadinessEventsOfType(events, ports.EventAgentReady), "historical v1 ready is retained but the old ACK cannot prove v2 ready")
	bound := agentReadinessEventsOfType(events, ports.EventRuntimeBound)
	require.Len(t, bound, 1)
	agentReadinessAssertProof(t, bound[0], input, bootstrapped.Revision, 0)
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, bootstrapped.Revision, fact.ReadyAfterRevision)
	require.Nil(t, fact.ReadyAt)
	require.Equal(t, bootstrapped.Revision, currentExecutionSnapshot(t, repo, base.Agent.OrganizationID).Revision)
	require.True(t, publishedAgent(t, repo, base.Agent).AcceptingRuns)

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: bootstrapped.Revision,
	}))
	finalEvents := agentReadinessEvents(t, ctx, repo, base.Agent)
	ready := agentReadinessEventsOfType(finalEvents, ports.EventAgentReady)
	require.Len(t, ready, 2)
	require.Equal(t, legacyReady[0], ready[0])
	agentReadinessAssertProof(t, ready[1], input, bootstrapped.Revision, bootstrapped.Revision)
	require.Len(t, agentReadinessEventsOfType(finalEvents, ports.EventRuntimeBound), 1)
	final, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, bootstrapped.Revision, final.Revision)
	require.Equal(t, bootstrapped.Revision, final.AppliedRevision)
}

func TestAgentReadinessACKAndBootstrapBoundariesRollbackAtomically(t *testing.T) {
	t.Run("future_ACK_cannot_be_laundered_by_legacy_bootstrap", func(t *testing.T) {
		ctx, repo, _ := controllerTestConnection(t)
		base, _ := agentReadinessSeedLegacyBinding(t, ctx, repo)
		state, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
		require.NoError(t, err)
		before := agentReadinessDatabaseState(t, ctx, repo, base.Agent)
		require.Error(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
			OrganizationID: base.Agent.OrganizationID, AppliedRevision: state.Revision + 1,
		}))
		require.Equal(t, before, agentReadinessDatabaseState(t, ctx, repo, base.Agent), "reject the future ACK before any watermark, bootstrap fact, event or revision change")
	})

	t.Run("legacy_bootstrap_at_MAX_SAFE_rolls_back_ACK", func(t *testing.T) {
		ctx, repo, _ := controllerTestConnection(t)
		base, _ := agentReadinessSeedLegacyBinding(t, ctx, repo)
		_, err := repo.pool.Exec(ctx, `UPDATE agent_controller.execution_configuration_sync SET revision=$2 WHERE organization_id=$1`, base.Agent.OrganizationID, ports.MaximumExecutionRevision)
		require.NoError(t, err)
		before := agentReadinessDatabaseState(t, ctx, repo, base.Agent)
		require.Error(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
			OrganizationID: base.Agent.OrganizationID, AppliedRevision: ports.MaximumExecutionRevision,
		}))
		require.Equal(t, before, agentReadinessDatabaseState(t, ctx, repo, base.Agent), "an exhausted bootstrap revision cannot partially commit its ACK")
	})

	t.Run("binding_at_MAX_SAFE_rolls_back_execution_and_event", func(t *testing.T) {
		ctx, repo, _ := controllerTestConnection(t)
		base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
		op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
		require.NoError(t, err)
		input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-readiness-max", "max-process", "http://max-runtime:8091/mcp")
		_, err = repo.pool.Exec(ctx, `UPDATE agent_controller.execution_configuration_sync SET revision=$2 WHERE organization_id=$1`, base.Agent.OrganizationID, ports.MaximumExecutionRevision)
		require.NoError(t, err)
		before := agentReadinessDatabaseState(t, ctx, repo, base.Agent)
		changed, err := repo.PublishRuntimeBinding(ctx, input)
		require.Error(t, err)
		require.False(t, changed)
		require.Equal(t, before, agentReadinessDatabaseState(t, ctx, repo, base.Agent))
	})
}

func agentReadinessEvents(t *testing.T, ctx context.Context, repo *Repository, agent ports.AgentRecord) []ports.AgentEventRecord {
	t.Helper()
	events, err := repo.ListAgentEvents(ctx, ports.AgentEventQuery{OrganizationID: agent.OrganizationID, AgentID: agent.AgentID, Limit: 1000})
	require.NoError(t, err)
	return events
}

func agentReadinessEventsOfType(events []ports.AgentEventRecord, eventType string) []ports.AgentEventRecord {
	var result []ports.AgentEventRecord
	for _, event := range events {
		if event.EventType == eventType {
			result = append(result, event)
		}
	}
	return result
}

func agentReadinessAssertProof(t *testing.T, event ports.AgentEventRecord, binding ports.PublishRuntimeBinding, threshold, applied int64) {
	t.Helper()
	require.Equal(t, 2, event.SchemaVersion)
	require.Equal(t, binding.Execution.AgentID, event.AgentID)
	data := map[string]any{
		"organization_id":        "org-integration",
		"agent_spec_revision_id": binding.Execution.AgentSpecRevisionID,
		"execution_revision_id":  binding.Execution.ID,
		"runtime_revision":       binding.Execution.RuntimeRevision,
		"ready_after_revision":   threshold,
	}
	if applied != 0 {
		require.Equal(t, ports.EventAgentReady, event.EventType)
		data["applied_revision"] = applied
	} else {
		require.Equal(t, ports.EventRuntimeBound, event.EventType)
	}
	want, err := json.Marshal(data)
	require.NoError(t, err)
	got, err := json.Marshal(event.Data)
	require.NoError(t, err)
	require.JSONEq(t, string(want), string(got), "v2 proof must contain exactly the public binding identity and organization watermarks")
}

type agentReadinessFactState struct {
	ExecutionRevisionID string
	ReadyAfterRevision  int64
	AppliedRevision     int64
	ReadyAt             *time.Time
}

func agentReadinessFactForTest(t *testing.T, ctx context.Context, repo *Repository, agentID string) agentReadinessFactState {
	t.Helper()
	var fact agentReadinessFactState
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT execution_revision_id, ready_after_revision, COALESCE(applied_revision,0), ready_at
FROM agent_controller.agent_runtime_readiness WHERE agent_id=$1`, agentID).Scan(
		&fact.ExecutionRevisionID, &fact.ReadyAfterRevision, &fact.AppliedRevision, &fact.ReadyAt,
	))
	return fact
}

// Reproduce a deployed legacy binding through the pre-readiness storage path.
// Calling the new PublishRuntimeBinding here would manufacture the missing fact
// that this fixture is meant to exercise. The historical event stays v1.
func agentReadinessSeedLegacyBinding(t *testing.T, ctx context.Context, repo *Repository) (ports.AgentLifecycleBase, ports.PublishRuntimeBinding) {
	t.Helper()
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-readiness-legacy", "legacy-process", "http://legacy-runtime:8091/mcp")
	legacyReadyEvent := input.BoundEvent
	legacyReadyEvent.SchemaVersion = 1
	legacyReadyEvent.EventType = ports.EventAgentReady
	tx, err := repo.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	require.NoError(t, insertExecutionRevision(ctx, tx, input.Execution))
	_, err = tx.Exec(ctx, `UPDATE agent_controller.agents
SET runtime_state='available', runtime_reason='', runtime_detail='', runtime_observed_at=$6,
    executable_execution_revision_id=$2, last_successful_execution_revision_id=$2,
    runtime_execution_id=$3, runtime_mcp_endpoint=$4, aggregate_sequence=$5, updated_at=$6,
    failure_stage='', failure_code='', failure_detail=''
WHERE id=$1`, base.Agent.AgentID, input.Execution.ID, input.Execution.RuntimeExecutionID,
		input.Execution.RuntimeMCPEndpoint, legacyReadyEvent.AggregateSequence, input.Execution.PublishedAt)
	require.NoError(t, err)
	require.NoError(t, repo.insertAgentEvent(ctx, tx, legacyReadyEvent))
	require.NoError(t, repo.advanceExecutionRevision(ctx, tx, base.Agent.OrganizationID))
	require.NoError(t, tx.Commit(ctx))
	base, err = repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
	require.NoError(t, err)
	return base, input
}

func agentReadinessDatabaseState(t *testing.T, ctx context.Context, repo *Repository, agent ports.AgentRecord) []string {
	t.Helper()
	var state string
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'agent', (SELECT to_jsonb(a) FROM agent_controller.agents a WHERE a.id=$1),
 'sync', (SELECT to_jsonb(s) FROM agent_controller.execution_configuration_sync s WHERE s.organization_id=$2),
 'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.global_sequence),'[]'::jsonb) FROM agent_controller.agent_events e WHERE e.agent_id=$1),
 'executions', (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM agent_controller.execution_revisions e WHERE e.agent_id=$1),
 'operations', (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.request_id),'[]'::jsonb) FROM agent_controller.agent_lifecycle_operations o WHERE o.agent_id=$1),
 'cursor', (SELECT to_jsonb(c) FROM agent_controller.event_journal_cursor c WHERE c.singleton=TRUE)
)::text`, agent.AgentID, agent.OrganizationID).Scan(&state))
	// Keep the baseline on real behavior assertions even before migration 0031
	// exists, while also checking the complete new fact once it is installed.
	var exists bool
	require.NoError(t, repo.pool.QueryRow(ctx, `SELECT to_regclass('agent_controller.agent_runtime_readiness') IS NOT NULL`).Scan(&exists))
	facts := "absent"
	if exists {
		require.NoError(t, repo.pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.execution_revision_id),'[]'::jsonb)::text
FROM agent_controller.agent_runtime_readiness r WHERE r.agent_id=$1`, agent.AgentID).Scan(&facts))
	}
	return []string{state, facts}
}
