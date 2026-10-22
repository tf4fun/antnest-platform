package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func runtimeBarrierManualTestPolicy(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, mode string) runtimeBarrierAdmissionFixture {
	t.Helper()
	if fixture.policy.Mode != mode {
		policy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
			fixture.base.Agent.OrganizationID, "manual-source-policy-"+mode, fixture.policy.Revision, mode, 300000,
		))
		require.NoError(t, err)
		fixture.policy = policy
		fixture.begin.Recovery.ExpectedPolicyRevision = policy.Revision
	}
	return fixture
}

func runtimeBarrierManualTestSource(t *testing.T, fixture runtimeBarrierAdmissionFixture, manual bool, actor string) runtimeBarrierAdmissionFixture {
	t.Helper()
	fixture.begin = runtimeBarrierAdmissionGuardInput(fixture.begin)
	fixture.begin.Recovery.Manual = manual
	fixture.begin.Recovery.Command.ActorPrincipalID = actor
	// Manual is separate provenance. The original six-field lifecycle command,
	// including its actual actor, still owns the unchanged fingerprint format.
	payload, err := json.Marshal(fixture.begin.Recovery.Command)
	require.NoError(t, err)
	digest := sha256.Sum256(payload)
	fixture.begin.Operation.RequestFingerprint = hex.EncodeToString(digest[:])
	data := make(map[string]any, len(fixture.begin.RequestedEvent.Data))
	for key, value := range fixture.begin.RequestedEvent.Data {
		data[key] = value
	}
	data["actor_principal_id"] = actor
	fixture.begin.RequestedEvent.Data = data
	return fixture
}

func assertRuntimeBarrierManualTestRow(t *testing.T, ctx context.Context, store *Repository, requestID string, expected bool) {
	t.Helper()
	var manual bool
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT manual
FROM agent_controller.runtime_barrier_recovery_receipts WHERE request_id=$1`, requestID).Scan(&manual))
	require.Equal(t, expected, manual, "manual provenance must be stored independently of the actor")
}

func TestRuntimeBarrierRecoveryManualAdmissionPersistsAcrossPolicies(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-policy-barrier", "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, mode)
			fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
			counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
			state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
			require.NoError(t, err)
			require.False(t, replayed)
			assertOneRuntimeBarrierAdmission(t, ctx, fixture, counts)
			original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, state, original)
			require.True(t, original.Manual)
			require.Equal(t, "admin-1", original.Command.ActorPrincipalID)
			require.Equal(t, mode, original.Policy.Mode)
			assertRuntimeBarrierManualTestRow(t, ctx, fixture.store, original.Command.RequestID, true)

			fixture.store.Close()
			reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
			recovered := runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin)
			require.Equal(t, original, recovered)
			require.True(t, recovered.Manual)
			assertRuntimeBarrierManualTestRow(t, ctx, reopened, original.Command.RequestID, true)
			pending, err := reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
			require.NoError(t, err)
			require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending, "pending starts must retain the original manual command and policy")
		})
	}
}

func TestRuntimeBarrierRecoveryManualOriginalReceiptReplayDoesNotRenewCooldown(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-original-replay-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "manual")
	fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	require.True(t, original.Manual)
	changedPolicy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		fixture.base.Agent.OrganizationID, "manual-replay-later-policy", fixture.policy.Revision, "auto", 60000,
	))
	require.NoError(t, err)
	beforeReplay := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	fixture.store.Close()

	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	retry := runtimeBarrierAdmissionGuardInput(fixture.begin)
	retry.Now = original.CooldownUntil.Add(24 * time.Hour)
	for range 2 {
		replayedState, replayed, err := reopened.BeginAgentRebuild(ctx, retry)
		require.NoError(t, err)
		require.True(t, replayed, "the original tuple is replayed before the newer policy and stale CAS")
		require.Equal(t, state.Operation, replayedState.Operation)
		require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
		assertRuntimeBarrierManualTestRow(t, ctx, reopened, original.Command.RequestID, true)
		require.Equal(t, beforeReplay, runtimeBarrierAdmissionSnapshot(t, ctx, reopened), "manual replay must not renew cooldown, append an event or create another target")
	}
	current, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, fixture.base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, changedPolicy, current)
	pending, err := reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending)
}

func TestRuntimeBarrierRecoveryManualDifferentBarrierHonorsActiveCooldown(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-first-cooldown-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "manual")
	fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	// End the actual operation through its repository API, preserving its source.
	// The next rejection must reach cooldown, not an already-running operation.
	finishRecoveryAdmissionBeforeRuntimeChange(t, ctx, fixture.store, state)
	base, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Empty(t, base.Agent.ActiveOperationRequestID)
	require.True(t, base.Agent.HasConfiguredRuntime())
	second := runtimeBarrierAdmissionForAgent(t, fixture.store, base, fixture.seed, fixture.policy, "manual-second-cooldown-barrier", "different-protected-execution")
	second = runtimeBarrierManualTestSource(t, second, true, "admin-1")
	require.NotEqual(t, original.Command.RequestID, second.begin.Operation.RequestID)
	var active bool
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT clock_timestamp()<cooldown_until
FROM agent_controller.runtime_barrier_recovery_cooldowns WHERE agent_id=$1 AND request_id=$2`,
		base.Agent.AgentID, original.Command.RequestID).Scan(&active))
	require.True(t, active, "the committed cooldown must actually still be active")
	before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	secondState, replayed, err := fixture.store.BeginAgentRebuild(ctx, second.begin)
	after := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	assert.ErrorIs(t, err, ports.ErrConcurrentChange)
	assert.NotErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery, "the second manual command is otherwise valid")
	assert.Equal(t, ports.AgentRebuildState{}, secondState)
	assert.False(t, replayed)
	assert.Equal(t, before, after, "cooldown rejection must leave all durable recovery and lifecycle effects unchanged")
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
	_, found, err := fixture.store.ReplayRuntimeBarrierRecovery(ctx, second.begin.Recovery.Fact.OrganizationID,
		second.begin.Recovery.Fact.AgentID, second.begin.Recovery.Fact.Barrier.BarrierID)
	require.NoError(t, err)
	require.False(t, found)
}

func TestRuntimeBarrierRecoveryManualFlagDoesNotRelaxAutomaticSourceGuards(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		mode          string
		actor         string
		expectedError error
	}{
		{"automatic internal source", "auto", "agent-controller", nil},
		{"automatic source under manual policy", "manual", "agent-controller", ports.ErrConcurrentChange},
		{"automatic source under notify policy", "notify", "agent-controller", ports.ErrConcurrentChange},
		{"administrator actor without manual provenance", "auto", "admin-1", ports.ErrInvalidRuntimeBarrierRecovery},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "automatic-source-guard-barrier", "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, scenario.mode)
			fixture = runtimeBarrierManualTestSource(t, fixture, false, scenario.actor)
			before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
			state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
			if scenario.expectedError != nil {
				after := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
				assert.ErrorIs(t, err, scenario.expectedError)
				assert.False(t, replayed)
				assert.Equal(t, ports.AgentRebuildState{}, state)
				assert.Equal(t, before, after, "automatic-source rejection must preserve all durable rows")
				return
			}
			require.NoError(t, err)
			require.False(t, replayed)
			receipt := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, state, receipt)
			require.False(t, receipt.Manual)
			assertRuntimeBarrierManualTestRow(t, ctx, fixture.store, receipt.Command.RequestID, false)
			pending, err := fixture.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
			require.NoError(t, err)
			require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipt}, pending)
		})
	}
}
