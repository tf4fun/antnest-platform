package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type runtimeBarrierAdmissionFixture struct {
	store  *Repository
	base   ports.AgentLifecycleBase
	seed   rebuildSeed
	policy domain.RuntimeBarrierRecoveryPolicy
	begin  ports.BeginAgentRebuild
}

func runtimeBarrierAdmissionSeed(t *testing.T, ctx context.Context, barrierID, executionID string) runtimeBarrierAdmissionFixture {
	t.Helper()
	store := openRuntimeBarrierPolicyTestRepository(t, ctx)
	base, seed := seedAvailableAgentForRebuild(t, ctx, store)
	policy, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		base.Agent.OrganizationID, "recovery-admission-policy", 0, "auto", 300000,
	))
	require.NoError(t, err)
	return runtimeBarrierAdmissionForAgent(t, store, base, seed, policy, barrierID, executionID)
}

func runtimeBarrierAdmissionForAgent(t *testing.T, store *Repository, base ports.AgentLifecycleBase, seed rebuildSeed, policy domain.RuntimeBarrierRecoveryPolicy, barrierID, executionID string) runtimeBarrierAdmissionFixture {
	t.Helper()
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(base.Agent.OrganizationID, base.Agent.AgentID, barrierID)
	require.NoError(t, err)
	require.Regexp(t, `^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`, requestID)
	command := ports.RuntimeBarrierRebuildCommand{
		RequestID: requestID, OrganizationID: base.Agent.OrganizationID,
		ActorPrincipalID: "agent-controller", AgentID: base.Agent.AgentID,
		TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision(),
	}
	// This is the existing six-field Rebuild fingerprint. Recovery observation,
	// policy, preparation time and execution facts must not change that wire.
	payload, err := json.Marshal(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{command.RequestID, command.OrganizationID, command.ActorPrincipalID, command.AgentID, command.TemplateID, command.TemplateRevision})
	require.NoError(t, err)
	digest := sha256.Sum256(payload)
	fingerprint := hex.EncodeToString(digest[:])
	target, err := domain.MaterializeAgentSpec(seed.Revision, seed.Model.Revision)
	require.NoError(t, err)
	targetDigest, err := target.Digest()
	require.NoError(t, err)
	targetID := domain.DeriveResourceID("agentspec", "agentspec-rebuild", requestID)
	// Preparation happened earlier. Acceptance and cooldown must instead use
	// the actual transaction's acceptance point after its locks are acquired.
	preparedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	drainDeadline := preparedAt.Add(5 * time.Minute)
	begin := ports.BeginAgentRebuild{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.ConfiguredSpec.ID, ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: targetID, AgentID: base.Agent.AgentID, Revision: base.NextSpecRevision,
			Snapshot: target.Snapshot(), CanonicalDigest: targetDigest, CreatedAt: preparedAt,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: fingerprint, AgentID: base.Agent.AgentID,
			Kind: domain.OperationRebuild, Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID: base.ConfiguredSpec.ID, SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: targetID,
			ChildRequestID:  domain.ChildRequestID(requestID, domain.PhaseDrain),
			DrainDeadlineAt: &drainDeadline, CreatedAt: preparedAt, UpdatedAt: preparedAt,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-rebuild-requested", requestID),
			AgentID: base.Agent.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentRebuildRequested, OperationRequestID: requestID,
			Data: map[string]any{
				"actor_principal_id":            command.ActorPrincipalID,
				"source_agent_spec_revision_id": base.ConfiguredSpec.ID,
				"source_runtime_revision":       base.Agent.RuntimeRevision,
				"target_agent_spec_revision_id": targetID,
				"template_id":                   command.TemplateID, "template_revision": command.TemplateRevision,
				"rebuild_reason": ports.ExecutionRuntimeBarrierRequired,
			},
			OccurredAt: preparedAt,
		},
		Recovery: &ports.RuntimeBarrierRecoveryIntent{
			Fact: ports.RuntimeBarrierResult{
				OrganizationID: base.Agent.OrganizationID, AgentID: base.Agent.AgentID,
				RuntimeRevision: base.Agent.RuntimeRevision,
				Barrier:         &ports.RuntimeBarrier{BarrierID: barrierID, Reason: ports.ExecutionRuntimeBarrierRequired, RuntimeExecutionID: executionID},
			},
			ExpectedPolicyRevision: policy.Revision, ExpectedOwnerUserID: base.Agent.OwnerUserID,
			ExpectedOwnerAuthorizationSequence: base.Agent.OwnerAuthorizationSequence,
			ExpectedIdentityRevocationSequence: base.Agent.IdentityRevocationSequence,
			Command:                            command,
		},
		Now: preparedAt,
	}
	return runtimeBarrierAdmissionFixture{store: store, base: base, seed: seed, policy: policy, begin: begin}
}

func runtimeBarrierAdmissionReceipt(t *testing.T, ctx context.Context, store *Repository, begin ports.BeginAgentRebuild) ports.RuntimeBarrierRecoveryReceipt {
	t.Helper()
	fact := begin.Recovery.Fact
	receipt, found, err := store.ReplayRuntimeBarrierRecovery(ctx, fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	require.True(t, found)
	return receipt
}

func assertRuntimeBarrierAdmissionReceipt(t *testing.T, fixture runtimeBarrierAdmissionFixture, state ports.AgentRebuildState, receipt ports.RuntimeBarrierRecoveryReceipt) {
	t.Helper()
	require.Equal(t, fixture.begin.Recovery.Fact, receipt.Fact)
	require.Equal(t, fixture.policy, receipt.Policy)
	require.Equal(t, fixture.begin.Recovery.Command, receipt.Command)
	require.Equal(t, fixture.begin.Operation.RequestFingerprint, receipt.RequestFingerprint)
	require.False(t, receipt.AcceptedAt.IsZero())
	require.True(t, state.Operation.CreatedAt.Equal(receipt.AcceptedAt), "operation creation is the accepted cooldown origin")
	require.True(t, receipt.CooldownUntil.Equal(receipt.AcceptedAt.Add(time.Duration(receipt.Policy.CooldownMS)*time.Millisecond)))
	require.True(t, receipt.AcceptedAt.After(fixture.begin.Now), "earlier preparation time is not acceptance")
}

type runtimeBarrierAdmissionCounts struct {
	specs      int64
	operations int64
	events     int64
	receipts   int64
	cooldowns  int64
	starts     int64
}

func readRuntimeBarrierAdmissionCounts(t *testing.T, ctx context.Context, store *Repository, agentID string) runtimeBarrierAdmissionCounts {
	t.Helper()
	var counts runtimeBarrierAdmissionCounts
	err := store.pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM agent_controller.agent_spec_revisions WHERE agent_id=$1),
(SELECT count(*) FROM agent_controller.agent_lifecycle_operations WHERE agent_id=$1 AND kind='rebuild'),
(SELECT count(*) FROM agent_controller.agent_events WHERE agent_id=$1 AND event_type='agent_rebuild_requested'),
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_receipts),
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_cooldowns),
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_starts)`, agentID).Scan(
		&counts.specs, &counts.operations, &counts.events, &counts.receipts, &counts.cooldowns, &counts.starts,
	)
	require.NoError(t, err)
	return counts
}

func assertOneRuntimeBarrierAdmission(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, before runtimeBarrierAdmissionCounts) {
	t.Helper()
	require.Equal(t, runtimeBarrierAdmissionCounts{
		specs: before.specs + 1, operations: before.operations + 1, events: before.events + 1,
		receipts: before.receipts + 1, cooldowns: before.cooldowns + 1, starts: before.starts + 1,
	}, readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID))
}

func runtimeBarrierAdmissionSnapshot(t *testing.T, ctx context.Context, store *Repository) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	for _, table := range []string{
		"agents", "agent_spec_revisions", "execution_revisions", "agent_lifecycle_operations", "agent_events",
		"event_journal_cursor", "execution_configuration_sync", "runtime_barrier_recovery_policies",
		"agent_templates", "agent_template_revisions", "runtime_barrier_recovery_receipts",
		"runtime_barrier_recovery_cooldowns", "runtime_barrier_recovery_starts",
	} {
		var value string
		query := `SELECT COALESCE(jsonb_agg(to_jsonb(resource) ORDER BY to_jsonb(resource)::text),'[]'::jsonb)::text FROM ` +
			pgx.Identifier{"agent_controller", table}.Sanitize() + ` resource`
		require.NoError(t, store.pool.QueryRow(ctx, query).Scan(&value))
		snapshot[table] = value
	}
	return snapshot
}

func TestRuntimeBarrierRecoveryAdmissionConcurrentTupleCommitsOneEffect(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "one-concurrent-barrier", "original-protected-execution")
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	before := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	beforeSync, err := fixture.store.GetExecutionSynchronization(ctx, fixture.base.Agent.OrganizationID)
	require.NoError(t, err)
	type outcome struct {
		state    ports.AgentRebuildState
		replayed bool
		err      error
	}
	results := make([]outcome, 2)
	start := make(chan struct{})
	var ready, joined sync.WaitGroup
	ready.Add(2)
	joined.Add(2)
	for index, store := range []*Repository{fixture.store, other} {
		go func(index int, store *Repository) {
			defer joined.Done()
			ready.Done()
			<-start
			results[index].state, results[index].replayed, results[index].err = store.BeginAgentRebuild(ctx, fixture.begin)
		}(index, store)
	}
	ready.Wait()
	close(start)
	joined.Wait()
	accepted, replayed := 0, 0
	for _, result := range results {
		require.NoError(t, result.err)
		if result.replayed {
			replayed++
		} else {
			accepted++
		}
		require.Equal(t, fixture.begin.Operation.RequestID, result.state.Operation.RequestID)
		require.Equal(t, fixture.begin.TargetSpec.ID, result.state.TargetSpec.ID)
		require.Equal(t, fixture.begin.TargetSpec.CanonicalDigest, result.state.TargetSpec.CanonicalDigest)
		require.Equal(t, fixture.base.Agent.AggregateSequence+1, result.state.Agent.AggregateSequence)
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 1, replayed)
	assertOneRuntimeBarrierAdmission(t, ctx, fixture, before)
	afterSync, err := fixture.store.GetExecutionSynchronization(ctx, fixture.base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, beforeSync.Revision+1, afterSync.Revision, "concurrent replay must not advance publication twice")
	receipt := runtimeBarrierAdmissionReceipt(t, ctx, other, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, results[0].state, receipt)
	pending, err := other.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipt}, pending)
}

func TestRuntimeBarrierRecoveryAdmissionOriginalReceiptSurvivesPolicyTemplateChangeAndReopen(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "original-receipt-barrier", "original-protected-execution")
	started, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, started, original)
	changedPolicy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		fixture.base.Agent.OrganizationID, "changed-recovery-policy", fixture.policy.Revision, "manual", 60000,
	))
	require.NoError(t, err)
	current, err := fixture.store.GetTemplate(ctx, fixture.begin.Recovery.Command.TemplateID)
	require.NoError(t, err)
	changedTemplate, err := fixture.store.ReviseTemplate(ctx, current.Revision.Revision(), integrationRevisedTemplateRecord(t, current, fixture.seed.Model.Revision))
	require.NoError(t, err)
	require.NotEqual(t, original.Command.TemplateRevision, changedTemplate.Revision.Revision())
	beforeReplay := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	fixture.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	recovered := runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin)
	require.Equal(t, original, recovered)
	retry := fixture.begin
	retry.Now = original.CooldownUntil.Add(24 * time.Hour)
	state, replayed, err := reopened.BeginAgentRebuild(ctx, retry)
	require.NoError(t, err)
	require.True(t, replayed, "original receipt is checked before the newer policy or Template")
	require.Equal(t, started.Operation, state.Operation)
	// Snapshot JSON intentionally omits empty Skill slices and MCP secret maps.
	// Reopening must retain the original persisted value, not Go-only nilness.
	originalTarget, err := json.Marshal(started.TargetSpec)
	require.NoError(t, err)
	replayedTarget, err := json.Marshal(state.TargetSpec)
	require.NoError(t, err)
	require.JSONEq(t, string(originalTarget), string(replayedTarget))
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
	require.Equal(t, beforeReplay, runtimeBarrierAdmissionSnapshot(t, ctx, reopened), "replay must not renew cooldown or append business effects")
	policy, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, fixture.base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, changedPolicy, policy)
}

func installRuntimeBarrierAdmissionFault(t *testing.T, ctx context.Context, store *Repository, table string) func() error {
	t.Helper()
	require.Contains(t, []string{"agent_events", "runtime_barrier_recovery_receipts", "runtime_barrier_recovery_cooldowns", "runtime_barrier_recovery_starts"}, table)
	const function = "runtime_barrier_admission_test_fault"
	_, err := store.pool.Exec(ctx, `CREATE FUNCTION agent_controller.runtime_barrier_admission_test_fault()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='injected recovery admission insert failure';
END;
$$`)
	require.NoError(t, err)
	qualifiedTable := pgx.Identifier{"agent_controller", table}.Sanitize()
	restore := func() error {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, triggerErr := store.pool.Exec(cleanup, `DROP TRIGGER IF EXISTS `+function+` ON `+qualifiedTable)
		_, functionErr := store.pool.Exec(cleanup, `DROP FUNCTION IF EXISTS agent_controller.runtime_barrier_admission_test_fault()`)
		return errors.Join(triggerErr, functionErr)
	}
	t.Cleanup(func() {
		if err := restore(); err != nil {
			t.Errorf("remove owned recovery admission insert fault: %v", err)
		}
	})
	_, err = store.pool.Exec(ctx, `CREATE TRIGGER `+function+` BEFORE INSERT ON `+qualifiedTable+
		` FOR EACH ROW EXECUTE FUNCTION agent_controller.runtime_barrier_admission_test_fault()`)
	require.NoError(t, err)
	return restore
}

func TestRuntimeBarrierRecoveryAdmissionInsertFaultRollsBackAllEffects(t *testing.T) {
	for _, table := range []string{"agent_events", "runtime_barrier_recovery_receipts", "runtime_barrier_recovery_cooldowns", "runtime_barrier_recovery_starts"} {
		t.Run(table, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "rollback-barrier", "original-protected-execution")
			before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
			counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
			restore := installRuntimeBarrierAdmissionFault(t, ctx, fixture.store, table)
			state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
			require.Error(t, err)
			var databaseFailure *pgconn.PgError
			require.ErrorAs(t, err, &databaseFailure)
			require.Equal(t, "P0001", databaseFailure.Code, "the real PostgreSQL insert must reach the installed fault")
			require.False(t, replayed)
			require.Equal(t, ports.AgentRebuildState{}, state)
			require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store), "receipt, cooldown, command and all lifecycle writes roll back together")
			_, found, err := fixture.store.ReplayRuntimeBarrierRecovery(ctx, fixture.base.Agent.OrganizationID, fixture.base.Agent.AgentID, fixture.begin.Recovery.Fact.Barrier.BarrierID)
			require.NoError(t, err)
			require.False(t, found)
			pending, err := fixture.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
			require.NoError(t, err)
			require.Empty(t, pending)
			require.NoError(t, restore())
			state, replayed, err = fixture.store.BeginAgentRebuild(ctx, fixture.begin)
			require.NoError(t, err)
			require.False(t, replayed)
			assertOneRuntimeBarrierAdmission(t, ctx, fixture, counts)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, state, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
		})
	}
}

func TestRuntimeBarrierRecoveryAdmissionPendingStartSurvivesReopenAndConfirmation(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "pending-start-barrier", "original-protected-execution")
	_, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	// No workflow starter is called. Closing the real pool discards process
	// state; a newly opened repository must enumerate the committed command.
	fixture.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	pending, err := reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 1)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending)
	after, err := reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, original.Command.RequestID, 1)
	require.NoError(t, err)
	require.Empty(t, after, "the pending-start cursor is exclusive")
	wrongFingerprint := strings.Repeat("0", 64)
	if wrongFingerprint == original.RequestFingerprint {
		wrongFingerprint = strings.Repeat("1", 64)
	}
	beforeWrong := runtimeBarrierAdmissionSnapshot(t, ctx, reopened)
	require.Error(t, reopened.ConfirmRuntimeBarrierRecoveryStarted(ctx, original.Command.RequestID, wrongFingerprint))
	require.Equal(t, beforeWrong, runtimeBarrierAdmissionSnapshot(t, ctx, reopened))
	pending, err = reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 1)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending)
	var confirmed map[string]string
	for range 2 {
		require.NoError(t, reopened.ConfirmRuntimeBarrierRecoveryStarted(ctx, original.Command.RequestID, original.RequestFingerprint))
		pending, err = reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 1)
		require.NoError(t, err)
		require.Empty(t, pending)
		require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
		current := runtimeBarrierAdmissionSnapshot(t, ctx, reopened)
		if confirmed != nil {
			require.Equal(t, confirmed, current, "confirmation is monotonic and repeat acknowledgement changes nothing")
		}
		confirmed = current
	}
	require.Error(t, reopened.ConfirmRuntimeBarrierRecoveryStarted(ctx, original.Command.RequestID, wrongFingerprint))
	missingRequestID, err := ports.RuntimeBarrierRecoveryRequestID(original.Command.OrganizationID, original.Command.AgentID, "missing-start-barrier")
	require.NoError(t, err)
	require.NotEqual(t, original.Command.RequestID, missingRequestID)
	require.Error(t, reopened.ConfirmRuntimeBarrierRecoveryStarted(ctx, missingRequestID, original.RequestFingerprint))
	require.Equal(t, confirmed, runtimeBarrierAdmissionSnapshot(t, ctx, reopened), "invalid confirmation cannot overwrite or reset a recorded command")
}

func runtimeBarrierAdmissionSecondAgent(t *testing.T, ctx context.Context, store *Repository, base ports.AgentLifecycleBase) ports.AgentLifecycleBase {
	t.Helper()
	const agentID = "recovery-second-agent"
	input := identityCreate(base, agentID, base.Agent.OrganizationID, base.Agent.OwnerAuthorizationSequence)
	createdAt := time.Now().UTC().Add(-10 * time.Second).Truncate(time.Microsecond)
	input.Agent.CreatedAt, input.Agent.UpdatedAt = createdAt, createdAt
	input.Access.CreatedAt, input.Access.UpdatedAt = createdAt, createdAt
	input.Spec.CreatedAt = createdAt
	input.Operation.CreatedAt, input.Operation.UpdatedAt = createdAt, createdAt
	input.RequestedEvent.OccurredAt = createdAt
	_, replayed, err := store.BeginAgentCreate(ctx, input)
	require.NoError(t, err)
	require.False(t, replayed)
	requestID, fingerprint, now := input.Operation.RequestID, input.Operation.RequestFingerprint, input.Operation.CreatedAt
	attachment := *closedNetworkAttachment(agentID)
	_, err = store.RecordCreateNetwork(ctx, requestID, fingerprint, attachment,
		domain.ChildRequestID(requestID, domain.PhaseRuntimeInitialize), now.Add(time.Second))
	require.NoError(t, err)
	_, err = store.RecordCreateRuntime(ctx, requestID, fingerprint, ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222",
		LifecycleState: "provisioned", Health: "unknown",
	}, domain.ChildRequestID(requestID, domain.PhasePublish), now.Add(2*time.Second))
	require.NoError(t, err)
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	attachment.AttachmentResourceVersion++
	published, err := store.PublishAgentCreate(ctx, ports.PublishAgentCreate{
		RequestID: requestID, Fingerprint: fingerprint, NetworkAttachment: attachment,
		CreatedEvent: ports.AgentEventRecord{
			EventID: "event-ready-" + agentID, AgentID: agentID, AggregateSequence: input.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentCreated, OperationRequestID: requestID,
			Data: map[string]any{}, OccurredAt: now.Add(3 * time.Second),
		},
		Now: now.Add(3 * time.Second),
	})
	require.NoError(t, err)
	observeRuntimeForTest(t, ctx, store, published.Agent, published.Operation,
		"execution-"+agentID, "runtime-execution-"+agentID, "http://runtime-second:8091/mcp")
	second, err := store.GetAgentLifecycleBase(ctx, agentID)
	require.NoError(t, err)
	require.NotEmpty(t, second.SourceExecution.ID)
	return second
}

func TestRuntimeBarrierRecoveryAdmissionConfirmationKeepsOtherAgentPending(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	first := runtimeBarrierAdmissionSeed(t, ctx, "shared-barrier-identity", "first-protected-execution")
	secondBase := runtimeBarrierAdmissionSecondAgent(t, ctx, first.store, first.base)
	second := runtimeBarrierAdmissionForAgent(t, first.store, secondBase, first.seed, first.policy,
		"shared-barrier-identity", "second-protected-execution")
	require.NotEqual(t, first.begin.Operation.RequestID, second.begin.Operation.RequestID)
	require.NotEqual(t, first.begin.Operation.RequestFingerprint, second.begin.Operation.RequestFingerprint)
	var receipts []ports.RuntimeBarrierRecoveryReceipt
	for _, fixture := range []runtimeBarrierAdmissionFixture{first, second} {
		state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
		require.NoError(t, err)
		require.False(t, replayed)
		receipt := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
		assertRuntimeBarrierAdmissionReceipt(t, fixture, state, receipt)
		receipts = append(receipts, receipt)
	}
	pending, err := first.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.ElementsMatch(t, receipts, pending)
	before := runtimeBarrierAdmissionSnapshot(t, ctx, first.store)
	// Both identifiers are real, accepted records. A valid fingerprint for B
	// must never acknowledge either record when paired with A's request ID.
	require.Error(t, first.store.ConfirmRuntimeBarrierRecoveryStarted(ctx, receipts[0].Command.RequestID, receipts[1].RequestFingerprint))
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, first.store))
	require.NoError(t, first.store.ConfirmRuntimeBarrierRecoveryStarted(ctx, receipts[0].Command.RequestID, receipts[0].RequestFingerprint))
	pending, err = first.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipts[1]}, pending, "confirming A must leave B's original command and receipt pending")
	require.Equal(t, receipts[1], runtimeBarrierAdmissionReceipt(t, ctx, first.store, second.begin))
	afterFirst := runtimeBarrierAdmissionSnapshot(t, ctx, first.store)
	for table, original := range before {
		if table != "runtime_barrier_recovery_starts" {
			require.Equal(t, original, afterFirst[table], "start acknowledgement cannot change business data: %s", table)
		}
	}
	require.NoError(t, first.store.ConfirmRuntimeBarrierRecoveryStarted(ctx, receipts[0].Command.RequestID, receipts[0].RequestFingerprint))
	require.Equal(t, afterFirst, runtimeBarrierAdmissionSnapshot(t, ctx, first.store), "reconfirming A cannot consume or alter B")
	pending, err = first.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipts[1]}, pending)
	require.NoError(t, first.store.ConfirmRuntimeBarrierRecoveryStarted(ctx, receipts[1].Command.RequestID, receipts[1].RequestFingerprint))
	pending, err = first.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Empty(t, pending)
	require.Equal(t, receipts[0], runtimeBarrierAdmissionReceipt(t, ctx, first.store, first.begin))
	require.Equal(t, receipts[1], runtimeBarrierAdmissionReceipt(t, ctx, first.store, second.begin))
}

func assertRuntimeBarrierAdmissionOpaqueBytes(t *testing.T, ctx context.Context, store *Repository, barrierID, executionID string) {
	t.Helper()
	rows, err := store.pool.Query(ctx, `SELECT column_name FROM information_schema.columns
WHERE table_schema='agent_controller' AND table_name='runtime_barrier_recovery_receipts'
AND data_type='bytea' ORDER BY ordinal_position`)
	require.NoError(t, err)
	defer rows.Close()
	var columns []string
	for rows.Next() {
		var column string
		require.NoError(t, rows.Scan(&column))
		columns = append(columns, column)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	foundBarrier, foundExecution := false, false
	for _, column := range columns {
		var actual []byte
		query := `SELECT ` + pgx.Identifier{column}.Sanitize() + ` FROM agent_controller.runtime_barrier_recovery_receipts`
		require.NoError(t, store.pool.QueryRow(ctx, query).Scan(&actual))
		foundBarrier = foundBarrier || bytes.Equal(actual, []byte(barrierID))
		foundExecution = foundExecution || bytes.Equal(actual, []byte(executionID))
	}
	require.True(t, foundBarrier, "the original opaque barrier bytes must actually be stored as BYTEA")
	require.True(t, foundExecution, "the original opaque execution bytes must actually be stored as BYTEA")
}

func TestRuntimeBarrierRecoveryAdmissionPreservesOpaqueBarrierAndOriginalExecution(t *testing.T) {
	for _, test := range []struct{ name, barrier, execution string }{
		{"Unicode and punctuation", "阻断:/原🧪", "原执行:/β🧪"},
		{"NUL and Unicode", "阻断:/原\x00🧪", "原执行:/\x00β🧪"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, test.barrier, test.execution)
			require.NotEqual(t, test.execution, fixture.base.Agent.RuntimeExecutionID, "the protected execution predates the latest health observation")
			state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
			require.NoError(t, err)
			require.False(t, replayed)
			receipt := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, state, receipt)
			require.Equal(t, test.barrier, receipt.Fact.Barrier.BarrierID)
			require.Equal(t, test.execution, receipt.Fact.Barrier.RuntimeExecutionID)
			require.Equal(t, fixture.base.Agent.RuntimeExecutionID, state.Agent.RuntimeExecutionID)
			assertRuntimeBarrierAdmissionOpaqueBytes(t, ctx, fixture.store, test.barrier, test.execution)
			fixture.store.Close()
			reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
			require.Equal(t, receipt, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
			pending, err := reopened.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 1)
			require.NoError(t, err)
			require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{receipt}, pending)
		})
	}
}
