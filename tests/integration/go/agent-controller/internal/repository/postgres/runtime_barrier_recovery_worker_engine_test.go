package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

// These cases use the actual PostgreSQL admission and Temporal engine. No
// activity worker is started: this batch acknowledges engine acceptance of the
// immutable command, rather than claiming completion of the recovery lifecycle.
func TestRuntimeBarrierRecoveryWorkerEngineStartsOriginalAndConfirmsPending(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	before := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)
	store := &runtimeBarrierRecoveryWorkerEngineStore{Repository: fixture.seed.store}
	runner := newRuntimeBarrierRecoveryWorkerEngineRunner(t, store, fixture.service)

	require.NoError(t, runner.RunOnce(fixture.ctx))
	require.Equal(t, 1, store.confirmCount())
	pending, err := fixture.seed.store.ListPendingRuntimeBarrierRecoveryStarts(fixture.ctx, "", 1)
	require.NoError(t, err)
	require.Empty(t, pending, "the actual committed acknowledgement removes the original pending start")
	startedAt := runtimeBarrierRecoveryWorkerEngineStartedAt(t, fixture.ctx, fixture.seed.store, fixture.receipt.Command.RequestID)
	require.False(t, startedAt.Before(fixture.receipt.AcceptedAt))

	runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
	history := runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, fixture.command)
	require.Empty(t, history, "engine acceptance does not require executing or re-admitting lifecycle activities")
	require.Equal(t, 1, fixture.observed.executeCount())
	require.Equal(t, 0, fixture.observed.updateCount())
	require.Equal(t, fixture.receipt, runtimeBarrierAdmissionReceipt(t, fixture.ctx, fixture.seed.store, fixture.seed.begin))
	require.Equal(t, fixture.counts, readRuntimeBarrierAdmissionCounts(t, fixture.ctx, fixture.seed.store, fixture.seed.base.Agent.AgentID))
	after := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	assertRuntimeBarrierRecoveryWorkerEngineOnlyConfirmationChanged(t, before, after)
}

func TestRuntimeBarrierRecoveryWorkerEngineCommittedConfirmationResponseLossSurvivesRestart(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	before := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	// This is a synthetic caller-visible response loss only. The wrapper below
	// first awaits the real repository transaction's successful commit.
	confirmationResponseLost := errors.New("synthetic confirmation response loss after real PostgreSQL commit")
	store := &runtimeBarrierRecoveryWorkerEngineStore{
		Repository: fixture.seed.store, responseLoss: confirmationResponseLost,
	}
	runner := newRuntimeBarrierRecoveryWorkerEngineRunner(t, store, fixture.service)
	require.ErrorIs(t, runner.RunOnce(fixture.ctx), confirmationResponseLost)
	require.Equal(t, 1, store.confirmCount())
	startedAt := runtimeBarrierRecoveryWorkerEngineStartedAt(t, fixture.ctx, fixture.seed.store, fixture.receipt.Command.RequestID)
	pending, err := fixture.seed.store.ListPendingRuntimeBarrierRecoveryStarts(fixture.ctx, "", 1)
	require.NoError(t, err)
	require.Empty(t, pending, "response loss cannot undo the real committed confirmation")
	runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
	runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, fixture.command)
	afterCommit := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	assertRuntimeBarrierRecoveryWorkerEngineOnlyConfirmationChanged(t, before, afterCommit)

	// Discard the original worker and its actual pool. Open without reseeding:
	// the new worker can rely only on the persisted pending/confirmed state.
	fixture.seed.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, fixture.ctx)
	restartedStore := &runtimeBarrierRecoveryWorkerEngineStore{Repository: reopened}
	restarted := newRuntimeBarrierRecoveryWorkerEngineRunner(t, restartedStore, fixture.service)
	require.NoError(t, restarted.RunOnce(fixture.ctx))
	require.Equal(t, 0, restartedStore.confirmCount())
	require.Equal(t, 1, fixture.observed.executeCount(), "a confirmed original command is not dispatched again after worker restart")
	require.Equal(t, 0, fixture.observed.updateCount())
	pending, err = reopened.ListPendingRuntimeBarrierRecoveryStarts(fixture.ctx, "", 1)
	require.NoError(t, err)
	require.Empty(t, pending)
	require.Equal(t, startedAt, runtimeBarrierRecoveryWorkerEngineStartedAt(t, fixture.ctx, reopened, fixture.receipt.Command.RequestID))
	require.Equal(t, fixture.receipt, runtimeBarrierAdmissionReceipt(t, fixture.ctx, reopened, fixture.seed.begin))
	require.Equal(t, fixture.counts, readRuntimeBarrierAdmissionCounts(t, fixture.ctx, reopened, fixture.seed.base.Agent.AgentID))
	require.Equal(t, afterCommit, runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, reopened),
		"restart cannot change the original receipt, cooldown, acknowledgement or other durable state")
	afterRunID, afterStatus := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, runID, afterRunID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, afterStatus)
	runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, afterRunID, fixture.command)
}

func TestRuntimeBarrierRecoveryWorkerEngineCancellationJoinsActualStartAndKeepsPending(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	before := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	store := &runtimeBarrierRecoveryWorkerEngineStore{Repository: fixture.seed.store}
	runner := newRuntimeBarrierRecoveryWorkerEngineRunner(t, store, fixture.service)
	caller, cancel := context.WithCancel(fixture.ctx)
	started, cancellationSeen := make(chan struct{}), make(chan struct{})
	release, dependencyReturned, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseHeld := func() { releaseOnce.Do(func() { close(release) }) }
	fixture.observed.afterExecute = func(ctx context.Context, _ client.WorkflowRun) {
		// ExecuteWorkflow has already returned the real engine's run. Hold only
		// this pass-through adapter's return; do not replace a result or RPC.
		defer close(dependencyReturned)
		close(started)
		select {
		case <-ctx.Done():
			close(cancellationSeen)
		case <-release:
			return
		}
		<-release
	}
	results := make(chan error, 1)
	// Registered after the engine fixture, so release and actual RunOnce join
	// happen before its owned workflow/client/repository cleanup, even on failure.
	t.Cleanup(func() {
		cancel()
		releaseHeld()
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		// Even an incorrect early RunOnce return must not let fixture teardown
		// race a dependency whose real engine call has already started.
		select {
		case <-started:
			select {
			case <-dependencyReturned:
			case <-cleanup.Done():
				t.Error("the actual Temporal adapter did not return after release")
			}
		default:
		}
		select {
		case <-joined:
		case <-cleanup.Done():
			t.Error("the owned recovery worker did not join its released real-client adapter")
		}
	})
	go func() {
		defer close(joined)
		results <- runner.RunOnce(caller)
	}()
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, started, "the real engine start was not acknowledged")
	runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
	cancel()
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, cancellationSeen, "the actual held start did not receive worker cancellation")
	// Only non-completion uses a bounded observation window. Completion below
	// must come from actual adapter-return and RunOnce-join receipts.
	guard := time.NewTimer(50 * time.Millisecond)
	select {
	case <-joined:
		guard.Stop()
		t.Fatal("RunOnce returned before its actual held Temporal start settled")
	case <-guard.C:
	}
	releaseHeld()
	joinedContext, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	runtimeBarrierRecoveryEngineAwait(t, joinedContext, dependencyReturned, "the real-client adapter did not settle after release")
	runtimeBarrierRecoveryEngineAwait(t, joinedContext, joined, "RunOnce did not join the actual start")
	require.ErrorIs(t, <-results, context.Canceled)
	require.Equal(t, 0, store.confirmCount(), "a canceled round cannot confirm an accepted but unverified engine start")
	assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)
	require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store))
	afterRunID, afterStatus := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, runID, afterRunID, "the original real execution remains identifiable after cancellation")
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, afterStatus)
	runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, afterRunID, fixture.command)
	require.Equal(t, 1, fixture.observed.executeCount())
	require.Equal(t, 0, fixture.observed.updateCount())
}

func newRuntimeBarrierRecoveryWorkerEngineRunner(t *testing.T, store application.RuntimeBarrierRecoveryStartStore, starter application.RuntimeBarrierRecoveryStarter) *application.RuntimeBarrierRecoveryStartWorker {
	t.Helper()
	runner, err := application.NewRuntimeBarrierRecoveryStartWorker(store, starter, application.RuntimeBarrierRecoveryStartSchedule{
		PollInterval: time.Second, RoundTimeout: 15 * time.Second, BatchSize: 1,
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, runner)
	return runner
}

type runtimeBarrierRecoveryWorkerEngineStore struct {
	*Repository
	mu            sync.Mutex
	confirmations int
	responseLoss  error
}

func (store *runtimeBarrierRecoveryWorkerEngineStore) ConfirmRuntimeBarrierRecoveryStarted(ctx context.Context, requestID, fingerprint string) error {
	store.mu.Lock()
	store.confirmations++
	store.mu.Unlock()
	if err := store.Repository.ConfirmRuntimeBarrierRecoveryStarted(ctx, requestID, fingerprint); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	// The one-shot synthetic failure is strictly after the actual SQL commit.
	responseLoss := store.responseLoss
	store.responseLoss = nil
	return responseLoss
}

func (store *runtimeBarrierRecoveryWorkerEngineStore) confirmCount() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.confirmations
}

func runtimeBarrierRecoveryWorkerEngineStartedAt(t *testing.T, ctx context.Context, store *Repository, requestID string) time.Time {
	t.Helper()
	var startedAt *time.Time
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT started_at
FROM agent_controller.runtime_barrier_recovery_starts WHERE request_id=$1`, requestID).Scan(&startedAt))
	require.NotNil(t, startedAt, "the actual pending row must contain its committed acknowledgement time")
	require.False(t, startedAt.IsZero())
	return *startedAt
}

func assertRuntimeBarrierRecoveryWorkerEngineOnlyConfirmationChanged(t *testing.T, before, after map[string]string) {
	t.Helper()
	require.Len(t, after, len(before))
	require.Contains(t, before, "runtime_barrier_recovery_starts")
	require.Contains(t, after, "runtime_barrier_recovery_starts")
	require.NotEqual(t, before["runtime_barrier_recovery_starts"], after["runtime_barrier_recovery_starts"])
	for table, original := range before {
		if table == "runtime_barrier_recovery_starts" {
			continue
		}
		require.Contains(t, after, table)
		require.Equal(t, original, after[table], "worker confirmation must not alter table %s", table)
	}
}
