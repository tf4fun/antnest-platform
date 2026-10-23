package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryProjectionTombstoneFencesOldBarrierAndPreservesNotification(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "projection-fenced-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
	counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	require.Zero(t, counts.operations)
	require.Zero(t, counts.receipts)
	require.Zero(t, counts.cooldowns)
	require.Zero(t, counts.starts)

	original := runtimeBarrierProjectionInput(t, ctx, fixture)
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, original))
	current, err := fixture.store.GetAgent(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, fixture.base.Agent.AggregateSequence+1, current.AggregateSequence)
	fixture.base.Agent = current
	originalProjection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	assertRuntimeBarrierProjection(t, fixture, originalProjection, nil)
	runtimeBarrierProjectionRows(t, ctx, fixture.store, current.AgentID, 1, 1, 1)
	originalRows := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)

	clear := runtimeBarrierProjectionInput(t, ctx, fixture)
	clear.Fact.Barrier = nil
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, clear))
	require.Equal(t, clear.ExpectedObservationRevision+1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, current))
	projection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	require.Nil(t, projection, "a successful null observation must leave a durable tombstone")
	afterClear := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t, originalRows, afterClear, "runtime_barrier_recovery_observations")

	require.ErrorIs(t, fixture.store.RecordRuntimeBarrierObservation(ctx, original), ports.ErrConcurrentChange,
		"an old barrier input cannot resurrect the reason after a newer successful null")
	require.Equal(t, afterClear, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store), "stale barrier rejection has no writes in any Controller table")

	latest := runtimeBarrierProjectionInput(t, ctx, fixture)
	require.Equal(t, clear.ExpectedObservationRevision+1, latest.ExpectedObservationRevision)
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, latest))
	require.Equal(t, latest.ExpectedObservationRevision+1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, current))
	projection, err = fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	require.Equal(t, originalProjection, projection)
	assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t, afterClear,
		runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store), "runtime_barrier_recovery_observations")

	for _, mode := range []string{"manual", "notify"} {
		beforePolicy := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
		previousPolicyRevision := fixture.policy.Revision
		fixture.policy, err = fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
			current.OrganizationID, "projection-fencing-policy-"+mode, previousPolicyRevision, mode, fixture.policy.CooldownMS,
		))
		require.NoError(t, err)
		require.Equal(t, previousPolicyRevision+1, fixture.policy.Revision)
		afterPolicy := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
		assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t, beforePolicy, afterPolicy,
			"runtime_barrier_recovery_policies", "runtime_barrier_recovery_policy_requests")

		input := runtimeBarrierProjectionInput(t, ctx, fixture)
		require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, input))
		require.Equal(t, input.ExpectedObservationRevision+1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, current))
		projection, err = fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
		require.NoError(t, err)
		assertRuntimeBarrierProjection(t, fixture, projection, nil)
		require.Equal(t, originalProjection.NotificationID, projection.NotificationID)
		require.Equal(t, originalProjection.RebuildRequestID, projection.RebuildRequestID)
		afterObservation := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
		assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t, afterPolicy, afterObservation, "runtime_barrier_recovery_observations")
		require.Equal(t, originalRows["runtime_barrier_recovery_notifications"], afterObservation["runtime_barrier_recovery_notifications"],
			"the original notification payload retains its original policy revision")
		require.Equal(t, originalRows["agent_events"], afterObservation["agent_events"], "policy changes must not rewrite or append the original notification event")
		require.Equal(t, originalRows["agents"], afterObservation["agents"], "returning to notify must not advance the Agent aggregate again")
		runtimeBarrierProjectionRows(t, ctx, fixture.store, current.AgentID, 1, 1, 1)
		require.Equal(t, counts, readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, current.AgentID), "projection changes do not admit or start a Rebuild or acquire cooldown")
	}
}

func TestRuntimeBarrierRecoveryProjectionFencesPersistedOwnerRevocationWithoutAgentMutation(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "projection-owner-fenced-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, runtimeBarrierProjectionInput(t, ctx, fixture)))
	current, err := fixture.store.GetAgent(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	fixture.base.Agent = current
	input := runtimeBarrierProjectionInput(t, ctx, fixture)
	projection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	assertRuntimeBarrierProjection(t, fixture, projection, nil)
	beforeRevocation := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)

	// Only the durable Identity watermark changes. Agent and binding columns
	// deliberately remain current, so their own CAS cannot explain rejection.
	revokedSequence := current.OwnerAuthorizationSequence + 1
	require.Greater(t, revokedSequence, current.OwnerAuthorizationSequence)
	changed, err := fixture.store.pool.Exec(ctx, `INSERT INTO agent_controller.owner_revocations
(user_id,organization_id,sequence,reason,occurred_at)
VALUES ($1,$2,$3,'membership_deactivated',clock_timestamp())`, current.OwnerUserID, current.OrganizationID, revokedSequence)
	require.NoError(t, err)
	require.EqualValues(t, 1, changed.RowsAffected())
	var storedSequence int64
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT sequence FROM agent_controller.owner_revocations
WHERE user_id=$1 AND organization_id=$2`, current.OwnerUserID, current.OrganizationID).Scan(&storedSequence))
	require.Equal(t, revokedSequence, storedSequence)
	unchanged, err := fixture.store.GetAgent(ctx, current.AgentID)
	require.NoError(t, err)
	expected := current
	require.NotNil(t, expected.Readiness)
	readiness := *expected.Readiness
	readiness.OwnerRevocationSequence = revokedSequence
	expected.Readiness = &readiness
	require.Equal(t, expected, unchanged)
	require.Equal(t, "unavailable", unchanged.CurrentReadiness())
	afterRevocation := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t, beforeRevocation, afterRevocation, "owner_revocations")
	require.Equal(t, beforeRevocation["agent_access_bindings"], afterRevocation["agent_access_bindings"])
	require.Equal(t, beforeRevocation["identity_revocation_cursor"], afterRevocation["identity_revocation_cursor"])

	projection, err = fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	require.Nil(t, projection, "a persisted owner revocation must hide the projection before Agent reconciliation")
	require.ErrorIs(t, fixture.store.RecordRuntimeBarrierObservation(ctx, input), ports.ErrConcurrentChange,
		"even an otherwise identical fact and current observation stamp must recheck the durable owner watermark")
	require.Equal(t, afterRevocation, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store),
		"projection reads and revoked observations cannot append or mutate any Controller row")
	runtimeBarrierProjectionRows(t, ctx, fixture.store, current.AgentID, 1, 1, 1)
	counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, current.AgentID)
	require.Zero(t, counts.operations)
	require.Zero(t, counts.receipts)
	require.Zero(t, counts.cooldowns)
	require.Zero(t, counts.starts)
}

func assertRuntimeBarrierProjectionFencingOnlyTablesChanged(t *testing.T, before, after map[string]string, allowed ...string) {
	t.Helper()
	require.Len(t, after, len(before))
	for table, original := range before {
		require.Contains(t, after, table)
		mayChange := false
		for _, candidate := range allowed {
			mayChange = mayChange || table == candidate
		}
		if !mayChange {
			require.Equal(t, original, after[table], "unexpected write to Controller table %s", table)
		}
	}
}
