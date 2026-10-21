package postgres

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRepositoryObservationPruningCommitsWhileCompletionIsInflight(t *testing.T) {
	store, database, _ := integrationRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	epoch := observationTestEpoch(t, store, ctx)
	const expiredRows = 5000
	const gateKey int64 = 0x5445535450494e46
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (
    agent_id, runtime_revision, generation, spec_digest, kind, source, observed_at, recorded_at
)
SELECT '', '', 0, '', 'reconciled', 'prune_inflight_expired',
       NOW()-INTERVAL '2 hours', NOW()-INTERVAL '2 hours'
FROM generate_series(1,5000)`); err != nil {
		t.Fatal(err)
	}
	var seedFloor uint64
	if err := database.QueryRowContext(ctx, "SELECT MAX(sequence) FROM runtime_controller.observations").Scan(&seedFloor); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	operation := integrationOperation("prune-inflight-init", deployment.OperationInitializeRuntime, now)
	operation.AgentID = "prune-inflight-agent"
	operation.Transition = deployment.LifecycleInitializing
	started, replayed, err := store.BeginTransition(ctx, operation)
	if err != nil || replayed {
		t.Fatalf("prepare completion: replayed=%t err=%v", replayed, err)
	}
	started.State, started.Effect = deployment.OperationCompleted, deployment.EffectCompleted
	started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now)
	fact := deployment.Observation{
		AgentID: started.AgentID, RuntimeRevision: started.RuntimeRevision,
		Kind: deployment.ObservationInitialized, Source: "prune_inflight_completion", ObservedAt: now,
	}
	if _, err := database.ExecContext(ctx, fmt.Sprintf(`
CREATE FUNCTION runtime_controller.hold_prune_inflight_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'prune_inflight_completion' THEN
    PERFORM pg_advisory_xact_lock(%d);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hold_prune_inflight_completion AFTER INSERT ON runtime_controller.observations
FOR EACH ROW EXECUTE FUNCTION runtime_controller.hold_prune_inflight_completion();`, gateKey)); err != nil {
		t.Fatal(err)
	}
	gate, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gate.Close() }()
	var gatePID int
	if err := gate.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.ExecContext(ctx, "SELECT pg_advisory_lock($1)", gateKey); err != nil {
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	var releaseErr error
	release := func() {
		releaseOnce.Do(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			var unlocked bool
			if err := gate.QueryRowContext(cleanup, "SELECT pg_advisory_unlock($1)", gateKey).Scan(&unlocked); err != nil {
				releaseErr = fmt.Errorf("release inflight completion gate: %w", err)
				_ = discardConnection(gate)
			} else if !unlocked {
				releaseErr = fmt.Errorf("inflight completion gate was not held")
			}
		})
	}
	completion := &orderAppendResult{}
	completed := make(chan struct{})
	defer func() {
		cancel()
		release()
		<-completed
		if releaseErr != nil {
			t.Error(releaseErr)
		}
	}()
	go func() {
		defer close(completed)
		// Keep the raw transaction outcome visible instead of retrying 40001.
		value, err := store.completeOperation(ctx, started, &fact)
		completion.err = err
		if value != nil {
			completion.value = *value
		}
	}()
	waitCtx, stopWait := context.WithTimeout(ctx, 5*time.Second)
	defer stopWait()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		var blocked bool
		if err := database.QueryRowContext(waitCtx, `SELECT EXISTS (
SELECT 1 FROM pg_locks
WHERE NOT granted AND locktype='advisory' AND $1 = ANY(pg_blocking_pids(pid)))`, gatePID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-completed:
			t.Fatalf("completion did not reach its held INSERT: %v", completion.err)
		case <-waitCtx.Done():
			t.Fatal(waitCtx.Err())
		case <-poll.C:
		}
	}
	t.Logf("raw completion INSERT is blocked by test gate pid=%d before pruning", gatePID)
	pruneCtx, stopPrune := context.WithTimeout(ctx, 5*time.Second)
	defer stopPrune()
	var removed int64
	for {
		count, err := store.PruneObservationBatch(pruneCtx, epoch)
		if err != nil {
			t.Fatalf("pruning could not commit while completion was held: removed=%d err=%v", removed, err)
		}
		removed += count
		if count == 0 {
			break
		}
	}
	if removed != expiredRows {
		t.Fatalf("removed expired facts=%d, want %d", removed, expiredRows)
	}
	select {
	case <-completed:
		t.Fatalf("completion ended before its gate was released: %v", completion.err)
	default:
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 0 || window.PrunedThrough != seedFloor ||
		window.LatestSequence != seedFloor || window.OldestSequence != 0 {
		t.Fatalf("committed prune prefix while completion is held: %+v want floor=%d err=%v", window, seedFloor, err)
	}
	pending, err := store.GetOperation(ctx, started.RequestID)
	if err != nil || pending.State != deployment.OperationRunning {
		t.Fatalf("uncommitted completion leaked its operation state: %+v err=%v", pending, err)
	}
	initializing, err := store.GetEnvironment(ctx, started.AgentID)
	if err != nil || initializing.LifecycleState != deployment.LifecycleInitializing || initializing.OperationID != started.RequestID {
		t.Fatalf("uncommitted completion leaked its environment state: %+v err=%v", initializing, err)
	}
	release()
	select {
	case <-completed:
	case <-ctx.Done():
		t.Fatalf("completion did not finish after gate release: %v", ctx.Err())
	}
	serializationFailures := 0
	if isSerializationFailure(completion.err) {
		serializationFailures++
	}
	t.Logf("inflight pruning removed=%d raw_sqlstate_40001=%d", removed, serializationFailures)
	if serializationFailures != 0 || completion.err != nil || completion.value.Sequence <= seedFloor {
		t.Fatalf("raw completion after committed pruning: fact=%+v raw_sqlstate_40001=%d err=%v",
			completion.value, serializationFailures, completion.err)
	}
	window, err = store.ListObservations(ctx, seedFloor, 10)
	if err != nil || len(window.Observations) != 1 || window.PrunedThrough != seedFloor ||
		window.OldestSequence != completion.value.Sequence || window.LatestSequence != completion.value.Sequence {
		t.Fatalf("completion fact was lost or duplicated after pruning: %+v err=%v", window, err)
	}
	observed := window.Observations[0]
	if observed.Sequence != completion.value.Sequence || observed.AgentID != started.AgentID ||
		observed.RuntimeRevision != started.RuntimeRevision || observed.Kind != fact.Kind || observed.Source != fact.Source {
		t.Fatalf("completion fact changed: %+v want=%+v", observed, completion.value)
	}
	saved, err := store.GetOperation(ctx, started.RequestID)
	if err != nil || saved.State != deployment.OperationCompleted || saved.Effect != deployment.EffectCompleted ||
		saved.Attempt != started.Attempt || saved.AgentID != observed.AgentID || saved.RuntimeRevision != observed.RuntimeRevision ||
		saved.Generation != started.Generation || saved.SpecDigest != started.SpecDigest || saved.Inspection == nil ||
		saved.Inspection.LifecycleState != deployment.LifecycleProvisioned {
		t.Fatalf("completion operation is inconsistent with its fact: %+v fact=%+v err=%v", saved, observed, err)
	}
	environment, err := store.GetEnvironment(ctx, started.AgentID)
	if err != nil || environment.LifecycleState != deployment.LifecycleProvisioned || environment.OperationID != "" ||
		environment.AgentID != observed.AgentID || environment.RuntimeRevision != observed.RuntimeRevision ||
		environment.Generation != saved.Generation || environment.SpecDigest != saved.SpecDigest {
		t.Fatalf("completion environment is inconsistent with its operation/fact: %+v operation=%+v fact=%+v err=%v",
			environment, saved, observed, err)
	}
	var retained int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM runtime_controller.observations").Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("retained observation count=%d, want 1: %v", retained, err)
	}
}
