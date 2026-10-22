package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func finishRecoveryAdmissionBeforeRuntimeChange(t *testing.T, ctx context.Context, store *Repository, state ports.AgentRebuildState) ports.AgentRebuildState {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	result, err := store.FailAgentRebuild(ctx, ports.FailAgentRebuild{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedAggregateSequence: state.Agent.AggregateSequence, Stage: state.Operation.Phase,
		Code: "fixture_drain_failure", PreserveExecutable: true, Now: now,
		FailedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-rebuild-failed", state.Operation.RequestID),
			AgentID: state.Agent.AgentID, SchemaVersion: 1, EventType: ports.EventAgentBuildFailed,
			OperationRequestID: state.Operation.RequestID, OccurredAt: now,
			Data: map[string]any{"failure_code": "fixture_drain_failure"},
		},
	})
	require.NoError(t, err)
	require.Empty(t, result.Agent.ActiveOperationRequestID)
	require.True(t, result.Agent.HasConfiguredRuntime())
	require.Equal(t, domain.OperationFailed, result.Operation.State)
	return result
}

func TestRuntimeBarrierRecoveryAdmissionCannotRetrofitOrdinaryOperation(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "ordinary-request-collision", "original-execution")
	ordinary := fixture.begin
	ordinary.Recovery = nil
	ordinary.RequestedEvent.Data = map[string]any{"actor_principal_id": "agent-controller"}
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, ordinary)
	require.NoError(t, err)
	require.False(t, replayed)
	finishRecoveryAdmissionBeforeRuntimeChange(t, ctx, fixture.store, state)
	before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	_, replayed, err = fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.ErrorIs(t, err, ports.ErrRequestConflict)
	require.False(t, replayed)
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store))
	counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	require.Zero(t, counts.receipts)
	require.Zero(t, counts.cooldowns)
	require.Zero(t, counts.starts)
}

func TestRuntimeBarrierRecoveryAdmissionCooldownSurvivesFailureReopenAndActualExpiry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "first-cooldown-barrier", "original-execution")
	policy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		fixture.base.Agent.OrganizationID, "minimum-cooldown", fixture.policy.Revision, "auto", 60000,
	))
	require.NoError(t, err)
	fixture.policy = policy
	fixture.begin.Recovery.ExpectedPolicyRevision = policy.Revision
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	failed := finishRecoveryAdmissionBeforeRuntimeChange(t, ctx, fixture.store, state)
	fixture.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	base, err := reopened.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Empty(t, base.Agent.ActiveOperationRequestID)
	require.True(t, base.Agent.HasConfiguredRuntime())
	second := runtimeBarrierAdmissionForAgent(t, reopened, base, fixture.seed, policy, "second-cooldown-barrier", "different-protected-execution")
	before := runtimeBarrierAdmissionSnapshot(t, ctx, reopened)
	_, replayed, err = reopened.BeginAgentRebuild(ctx, second.begin)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.False(t, replayed)
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, reopened))
	replay, replayed, err := reopened.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.True(t, replayed)
	require.Equal(t, failed.Operation.State, replay.Operation.State)
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, reopened))
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))

	// Wait on the actual committed deadline. No receipt, cooldown or database
	// clock is rewritten to fabricate expiration.
	for {
		var databaseNow time.Time
		require.NoError(t, reopened.pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&databaseNow))
		remaining := original.CooldownUntil.Sub(databaseNow)
		if remaining <= 0 {
			break
		}
		timer := time.NewTimer(remaining)
		select {
		case <-ctx.Done():
			timer.Stop()
			t.Fatal("actual cooldown did not expire within the bounded test", ctx.Err())
		case <-timer.C:
		}
	}
	accepted, replayed, err := reopened.BeginAgentRebuild(ctx, second.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	next := runtimeBarrierAdmissionReceipt(t, ctx, reopened, second.begin)
	require.False(t, next.AcceptedAt.Before(original.CooldownUntil))
	require.NotEqual(t, original.Command.RequestID, next.Command.RequestID)
	require.True(t, next.AcceptedAt.Equal(accepted.Operation.CreatedAt))
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
	var currentRequest string
	require.NoError(t, reopened.pool.QueryRow(ctx, "SELECT request_id FROM agent_controller.runtime_barrier_recovery_cooldowns WHERE agent_id=$1", base.Agent.AgentID).Scan(&currentRequest))
	require.Equal(t, next.Command.RequestID, currentRequest)
	counts := readRuntimeBarrierAdmissionCounts(t, ctx, reopened, base.Agent.AgentID)
	require.EqualValues(t, 2, counts.receipts)
	require.EqualValues(t, 1, counts.cooldowns)
	require.EqualValues(t, 2, counts.starts)
}
