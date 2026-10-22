package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestRuntimeBarrierRecoveryAdmissionCancellationJoinsJournalWait(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "cancelled-barrier", "cancelled-original-execution")
	worker := runtimeBarrierPolicySingleConnectionTestRepository(t, ctx)
	holder := openRuntimeBarrierPolicyTestRepository(t, ctx)
	const applicationName = "antnest-runtime-barrier-policy-cancel-test"
	var workerPID int32
	require.NoError(t, worker.pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&workerPID))
	before := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
	lock, err := holder.pool.Begin(ctx)
	require.NoError(t, err)
	mutationContext, cancelMutation := context.WithTimeout(ctx, 15*time.Second)
	results := make(chan error, 1)
	returned := make(chan struct{})
	started, released := false, false
	releaseHolder := func() error {
		if released {
			return nil
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		failure := lock.Rollback(cleanup)
		if failure == nil || errors.Is(failure, pgx.ErrTxClosed) {
			released = true
			return nil
		}
		return failure
	}
	waitReturned := func(budget time.Duration) bool {
		timer := time.NewTimer(budget)
		defer timer.Stop()
		select {
		case <-returned:
			return true
		case <-timer.C:
			return false
		}
	}
	t.Cleanup(func() {
		cancelMutation()
		if failure := releaseHolder(); failure != nil {
			t.Errorf("release owned admission cancellation blocker: %v", failure)
		}
		if !started || waitReturned(3*time.Second) {
			return
		}
		t.Error("actual admission did not join after cancellation and holder release")
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		var terminated bool
		failure := fixture.store.pool.QueryRow(cleanup, `SELECT pg_terminate_backend(pid)
FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
			workerPID, applicationName).Scan(&terminated)
		cancel()
		if failure != nil && !errors.Is(failure, pgx.ErrNoRows) {
			t.Errorf("terminate exact owned admission backend: %v", failure)
		} else if failure == nil && !terminated {
			t.Error("owned admission backend could not be terminated")
		}
		if !waitReturned(5 * time.Second) {
			t.Error("actual admission did not join after owned backend termination")
		}
	})
	var sequence int64
	require.NoError(t, lock.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.event_journal_cursor
WHERE singleton FOR UPDATE`).Scan(&sequence))
	var holderPID int32
	var holderTransactionID string
	require.NoError(t, lock.QueryRow(ctx, "SELECT pg_backend_pid(), pg_current_xact_id()::text").Scan(&holderPID, &holderTransactionID))
	require.NotEqual(t, workerPID, holderPID)
	started = true
	go func() {
		defer close(returned)
		_, _, failure := worker.BeginAgentRebuild(mutationContext, fixture.begin)
		results <- failure
	}()
	awaitRuntimeBarrierPolicyDatabaseCondition(t, ctx, "actual admission never waited on journal row", func(queryContext context.Context) (bool, error) {
		select {
		case <-returned:
			return false, errors.New("admission returned before observed journal wait")
		default:
		}
		var waiting bool
		failure := fixture.store.pool.QueryRow(queryContext, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity activity JOIN pg_locks waiting_lock ON waiting_lock.pid=activity.pid
 WHERE activity.pid=$1 AND activity.datname=current_database() AND activity.application_name=$2
   AND activity.state='active' AND activity.xact_start IS NOT NULL AND activity.wait_event_type='Lock'
   AND waiting_lock.locktype='transactionid' AND NOT waiting_lock.granted
   AND waiting_lock.transactionid::text=$3 AND $4=ANY(pg_blocking_pids(activity.pid))
   AND strpos(activity.query,'agent_controller.event_journal_cursor')>0
   AND EXISTS (SELECT 1 FROM pg_locks held_lock WHERE held_lock.pid=$4
     AND held_lock.locktype='transactionid' AND held_lock.granted
     AND held_lock.transactionid=waiting_lock.transactionid)
)`, workerPID, applicationName, holderTransactionID, holderPID).Scan(&waiting)
		return waiting, failure
	})
	cancelMutation()
	require.True(t, waitReturned(3*time.Second), "admission must join while the journal blocker remains held")
	require.ErrorIs(t, <-results, context.Canceled)
	// Observe the real backend, including pgx's asynchronous connection disposal.
	// The holder remains locked throughout the rollback and inventory assertions.
	awaitRuntimeBarrierPolicyDatabaseCondition(t, ctx, "cancelled admission retained transaction or locks", func(queryContext context.Context) (bool, error) {
		var transactions, locks int
		failure := fixture.store.pool.QueryRow(queryContext, `SELECT
 (SELECT count(*) FROM pg_stat_activity WHERE pid=$1 AND xact_start IS NOT NULL),
 (SELECT count(*) FROM pg_locks WHERE pid=$1)`, workerPID).Scan(&transactions, &locks)
		return transactions == 0 && locks == 0 && worker.pool.Stat().AcquiredConns() == 0, failure
	})
	var stillHeld bool
	require.NoError(t, lock.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks
WHERE pid=pg_backend_pid() AND locktype='transactionid' AND granted AND transactionid::text=$1)`, holderTransactionID).Scan(&stillHeld))
	require.True(t, stillHeld)
	require.Equal(t, before, runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store))
	require.NoError(t, releaseHolder())
	// Cancellation must not poison the original idempotency key or admission locks.
	state, replayed, err := worker.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, state, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
}
