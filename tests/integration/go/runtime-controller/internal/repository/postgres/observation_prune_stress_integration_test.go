package postgres

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRepositoryObservationPruningDoesNotAbortConcurrentWrites(t *testing.T) {
	// One SERIALIZABLE completion isolates pruning from completion-to-completion
	// SSI dependencies. All 100 writes are single attempts without retry masking.
	testObservationWriteConcurrency(t, observationWriteConcurrency{
		prune: true, appendWriters: 99, completionWriters: 1,
	})
}

func TestRepositoryObservationPruningPreservesConcurrentOperations(t *testing.T) {
	// Concurrent Agents use the production API's bounded whole-transaction retry.
	// This mode proves business persistence, not an absence of internal 40001s.
	testObservationWriteConcurrency(t, observationWriteConcurrency{
		prune: true, appendWriters: 50, completionWriters: 50, publicCompletion: true,
	})
}

type observationWriteConcurrency struct {
	prune             bool
	appendWriters     int
	completionWriters int
	publicCompletion  bool
}

func testObservationWriteConcurrency(t *testing.T, mode observationWriteConcurrency) {
	t.Helper()
	store, database, _ := integrationRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	epoch := observationTestEpoch(t, store, ctx)
	const expiredRows, writers = 5000, 100
	const gateKey int64 = 0x544553545052554e
	if mode.appendWriters+mode.completionWriters != writers ||
		(!mode.publicCompletion && mode.completionWriters != 1) {
		t.Fatal("observation concurrency mode must use 100 writers and one single-attempt completion unless testing the public API")
	}
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (
    agent_id, runtime_revision, generation, spec_digest, kind, source, observed_at, recorded_at
)
SELECT '', '', 0, '', 'reconciled', 'prune_stress_expired',
       NOW()-INTERVAL '2 hours', NOW()-INTERVAL '2 hours'
FROM generate_series(1,5000)`); err != nil {
		t.Fatal(err)
	}
	operations := make([]deployment.Operation, 0, mode.completionWriters)
	for index := range mode.completionWriters {
		now := time.Now().UTC()
		operation := integrationOperation(fmt.Sprintf("prune-stress-init-%d", index), deployment.OperationInitializeRuntime, now)
		operation.AgentID = fmt.Sprintf("prune-stress-agent-%d", index)
		operation.Transition = deployment.LifecycleInitializing
		started, replayed, err := store.BeginTransition(ctx, operation)
		if err != nil || replayed {
			t.Fatalf("prepare Agent %d: replayed=%t err=%v", index, replayed, err)
		}
		started.State, started.Effect = deployment.OperationCompleted, deployment.EffectCompleted
		started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now)
		operations = append(operations, started)
	}
	var gatePID int
	var releaseErr error
	release := func() {}
	if mode.prune {
		if _, err := database.ExecContext(ctx, fmt.Sprintf(`
CREATE FUNCTION runtime_controller.hold_observation_prune() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(%d);
  RETURN NULL;
END $$;
CREATE TRIGGER hold_observation_prune AFTER DELETE ON runtime_controller.observations
FOR EACH STATEMENT EXECUTE FUNCTION runtime_controller.hold_observation_prune();`, gateKey)); err != nil {
			t.Fatal(err)
		}
		gate, err := database.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = gate.Close() }()
		if err := gate.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&gatePID); err != nil {
			t.Fatal(err)
		}
		if _, err := gate.ExecContext(ctx, "SELECT pg_advisory_lock($1)", gateKey); err != nil {
			t.Fatal(err)
		}
		var releaseOnce sync.Once
		release = func() {
			releaseOnce.Do(func() {
				cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				var unlocked bool
				if err := gate.QueryRowContext(cleanup, "SELECT pg_advisory_unlock($1)", gateKey).Scan(&unlocked); err != nil {
					releaseErr = fmt.Errorf("release prune test gate: %w", err)
					_ = discardConnection(gate)
				} else if !unlocked {
					releaseErr = fmt.Errorf("prune test gate was not held")
				}
			})
		}
	}
	start := make(chan struct{})
	var startOnce sync.Once
	startWriters := func() { startOnce.Do(func() { close(start) }) }
	type writeResult struct {
		writer string
		err    error
	}
	results := make(chan writeResult, writers)
	var workers sync.WaitGroup
	received := 0
	pruned := struct {
		rows    int64
		batches int
		err     error
	}{}
	prunerDone := make(chan struct{})
	defer func() {
		cancel()
		release()
		startWriters()
		workers.Wait()
		for received < writers {
			<-results
			received++
		}
		<-prunerDone
		if releaseErr != nil {
			t.Error(releaseErr)
		}
	}()
	if mode.prune {
		go func() {
			defer close(prunerDone)
			for {
				count, err := store.PruneObservationBatch(ctx, epoch)
				if err != nil {
					pruned.err = err
					return
				}
				pruned.rows += count
				pruned.batches++
				if count == 0 {
					return
				}
			}
		}()
	} else {
		close(prunerDone)
	}
	for index := range mode.appendWriters {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			_, err := store.AppendObservation(ctx, epoch, deployment.Observation{
				Kind: deployment.ObservationReconciled, Source: "prune_stress_append", ObservedAt: time.Now().UTC(),
			})
			results <- writeResult{writer: fmt.Sprintf("append-%d", index), err: err}
		}(index)
	}
	for index, operation := range operations {
		workers.Add(1)
		go func(index int, operation deployment.Operation) {
			defer workers.Done()
			<-start
			fact := deployment.Observation{
				AgentID: operation.AgentID, RuntimeRevision: operation.RuntimeRevision,
				Kind: deployment.ObservationInitialized, Source: "prune_stress_completion", ObservedAt: time.Now().UTC(),
			}
			var value *deployment.Observation
			var err error
			if mode.publicCompletion {
				value, err = store.CompleteOperation(ctx, operation, &fact)
			} else {
				value, err = store.completeOperation(ctx, operation, &fact)
			}
			if err == nil && value == nil {
				err = fmt.Errorf("completion returned no observation")
			}
			results <- writeResult{writer: fmt.Sprintf("completion-%d", index), err: err}
		}(index, operation)
	}
	if mode.prune {
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
			case <-prunerDone:
				t.Fatalf("pruner did not reach its held DELETE: rows=%d err=%v", pruned.rows, pruned.err)
			case <-waitCtx.Done():
				t.Fatal(waitCtx.Err())
			case <-poll.C:
			}
		}
		t.Logf("pruner DELETE is blocked by test gate pid=%d before releasing %d writers", gatePID, writers)
	}
	startWriters()
	serializationFailures := 0
	successfulWrites := 0
	visibleErrors := 0
	for received < writers {
		select {
		case result := <-results:
			received++
			if !mode.publicCompletion && isSerializationFailure(result.err) {
				serializationFailures++
			}
			if result.err != nil {
				visibleErrors++
				t.Errorf("%s failed with prune=%t public_completion=%t: %v",
					result.writer, mode.prune, mode.publicCompletion, result.err)
			} else {
				successfulWrites++
			}
		case <-ctx.Done():
			t.Fatalf("received %d/%d write results: %v", received, writers, ctx.Err())
		}
	}
	workers.Wait()
	release()
	select {
	case <-prunerDone:
	case <-ctx.Done():
		t.Fatalf("pruner did not finish: %v", ctx.Err())
	}
	if mode.publicCompletion {
		t.Logf("production API: concurrent writes=%d/%d api_visible_errors=%d pruned_rows=%d batches=%d; internal retry attempts are not measured",
			successfulWrites, writers, visibleErrors, pruned.rows, pruned.batches)
	} else {
		if isSerializationFailure(pruned.err) {
			serializationFailures++
		}
		t.Logf("single-attempt writes with prune=%t: concurrent writes=%d/%d raw_sqlstate_40001=%d pruned_rows=%d batches=%d",
			mode.prune, successfulWrites, writers, serializationFailures, pruned.rows, pruned.batches)
		if serializationFailures != 0 {
			t.Errorf("raw serialization failures = %d, want 0", serializationFailures)
		}
	}
	if successfulWrites != writers || visibleErrors != 0 {
		t.Errorf("successful writes = %d/%d, visible errors = %d", successfulWrites, writers, visibleErrors)
	}
	expectedExpired, expectedPruned := expiredRows, int64(0)
	if mode.prune {
		expectedExpired, expectedPruned = 0, expiredRows
	}
	if pruned.err != nil || pruned.rows != expectedPruned {
		t.Errorf("pruner removed %d/%d expired facts: %v", pruned.rows, expectedPruned, pruned.err)
	}
	var expired, appended, completed, total int
	if err := database.QueryRowContext(ctx, `SELECT
COUNT(*) FILTER (WHERE source='prune_stress_expired'),
COUNT(*) FILTER (WHERE source='prune_stress_append'),
COUNT(*) FILTER (WHERE source='prune_stress_completion'), COUNT(*)
FROM runtime_controller.observations`).Scan(&expired, &appended, &completed, &total); err != nil {
		t.Fatal(err)
	}
	if expired != expectedExpired || appended != mode.appendWriters || completed != mode.completionWriters || total != expectedExpired+writers {
		t.Errorf("retained facts: expired=%d append=%d completion=%d total=%d; want %d/%d/%d/%d",
			expired, appended, completed, total, expectedExpired, mode.appendWriters, mode.completionWriters, expectedExpired+writers)
	}
	for _, operation := range operations {
		stored, err := store.GetOperation(ctx, operation.RequestID)
		if err != nil {
			t.Errorf("load completed operation %s: %v", operation.RequestID, err)
			continue
		}
		if stored.State != deployment.OperationCompleted || stored.Effect != deployment.EffectCompleted || stored.Inspection == nil {
			t.Errorf("operation %s did not persist its terminal result: %+v", operation.RequestID, stored)
			continue
		}
		inspection := stored.Inspection
		if inspection.AgentID != operation.AgentID || inspection.RuntimeRevision != operation.RuntimeRevision ||
			inspection.LifecycleState != deployment.LifecycleProvisioned ||
			inspection.MCPEndpoint != operation.Inspection.MCPEndpoint ||
			inspection.RuntimeExecutionID != operation.Inspection.RuntimeExecutionID {
			t.Errorf("operation %s persisted a different inspection: %+v", operation.RequestID, inspection)
		}
		environment, err := store.GetEnvironment(ctx, operation.AgentID)
		if err != nil {
			t.Errorf("load completed environment %s: %v", operation.AgentID, err)
			continue
		}
		if environment.AgentID != inspection.AgentID || environment.RuntimeRevision != inspection.RuntimeRevision ||
			environment.LifecycleState != inspection.LifecycleState || environment.OperationID != "" ||
			environment.Generation != operation.Generation || environment.SpecDigest != operation.SpecDigest {
			t.Errorf("operation %s and environment do not agree: inspection=%+v environment=%+v",
				operation.RequestID, inspection, environment)
		}
		var facts int
		var revision, kind string
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MIN(runtime_revision),''), COALESCE(MIN(kind),'')
FROM runtime_controller.observations WHERE source='prune_stress_completion' AND agent_id=$1`, operation.AgentID).
			Scan(&facts, &revision, &kind); err != nil {
			t.Errorf("load completion facts for %s: %v", operation.AgentID, err)
			continue
		}
		if facts != 1 || revision != string(operation.RuntimeRevision) || kind != string(deployment.ObservationInitialized) {
			t.Errorf("completion fact missing, duplicated, or mismatched for %s: count=%d revision=%q kind=%q",
				operation.AgentID, facts, revision, kind)
		}
	}
}
