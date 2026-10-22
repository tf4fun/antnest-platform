package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryManualMigrationPreservesExistingAutomaticReceipt(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "automatic-predecessor-barrier", "original-protected-execution")
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, state, original)
	require.False(t, original.Manual)
	before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	historicalJournal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 28)
	persistedState, found, err := fixture.store.ReplayAgentRebuild(ctx, original.Command.RequestID, original.RequestFingerprint)
	require.NoError(t, err)
	require.True(t, found)
	pending, err := fixture.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending)

	// The seed owns and resets this test database. Construct its populated 0028
	// equivalent predecessor schema transactionally; this does not execute an
	// old service binary or claim an old-binary compatibility test.
	tx, err := fixture.store.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if failure := tx.Rollback(cleanup); failure != nil && !errors.Is(failure, pgx.ErrTxClosed) {
			t.Errorf("release owned predecessor-schema transaction: %v", failure)
		}
	}()
	// Undo 0030's empty projection tables and restore the exact event-type
	// constraint from 0011_agent_state_hierarchy.sql, the last predecessor change.
	_, err = tx.Exec(ctx, `DROP TABLE agent_controller.runtime_barrier_recovery_notifications;
DROP TABLE agent_controller.runtime_barrier_recovery_observations;
ALTER TABLE agent_controller.agent_events DROP CONSTRAINT agent_events_type_known;
ALTER TABLE agent_controller.agent_events ADD CONSTRAINT agent_events_type_known CHECK (event_type IN (
    'agent_create_requested', 'agent_created', 'agent_ready', 'agent_build_failed',
    'agent_rebuild_requested', 'agent_rebuilt', 'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
    'agent_enable_requested', 'agent_enabled', 'agent_enable_failed', 'agent_delete_requested', 'agent_deleted',
    'agent_lifecycle_quarantined', 'agent_runtime_restarted', 'agent_runtime_missing', 'agent_runtime_condition_changed',
    'agent_owner_revoked', 'agent_authorization_updated'
));`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `ALTER TABLE agent_controller.runtime_barrier_recovery_receipts DROP COLUMN manual`)
	require.NoError(t, err)
	removed, err := tx.Exec(ctx, `DELETE FROM agent_controller.schema_migrations WHERE version IN (29,30)`)
	require.NoError(t, err)
	require.EqualValues(t, 2, removed.RowsAffected())
	require.NoError(t, tx.Commit(ctx))

	var version int64
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT max(version)
FROM agent_controller.schema_migrations`).Scan(&version))
	require.EqualValues(t, 28, version)
	var hasManual bool
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM information_schema.columns
WHERE table_schema='agent_controller'
  AND table_name='runtime_barrier_recovery_receipts' AND column_name='manual'
)`).Scan(&hasManual))
	require.False(t, hasManual)
	var receiptCount int64
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT count(*)
FROM agent_controller.runtime_barrier_recovery_receipts WHERE request_id=$1`, original.Command.RequestID).Scan(&receiptCount))
	require.EqualValues(t, 1, receiptCount, "the predecessor must already contain the actual automatic receipt")
	require.Equal(t, historicalJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 28))

	require.NoError(t, fixture.store.Migrate(ctx))
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT max(version)
FROM agent_controller.schema_migrations`).Scan(&version))
	require.EqualValues(t, 30, version)
	assertRuntimeBarrierManualTestRow(t, ctx, fixture.store, original.Command.RequestID, false)
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
	upgradedState, found, err := fixture.store.ReplayAgentRebuild(ctx, original.Command.RequestID, original.RequestFingerprint)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, persistedState, upgradedState)
	upgradedPending, err := fixture.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, pending, upgradedPending)
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store), "upgrade must preserve the receipt, operation, target, cooldown, pending start and all other business rows")
	require.Equal(t, historicalJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 28))

	upgradedJournal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 30)
	require.NoError(t, fixture.store.Migrate(ctx))
	require.Equal(t, upgradedJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 30))
	require.Equal(t, historicalJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, fixture.store, 28))
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store), "repeated migration must be a complete business no-op")
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
}
