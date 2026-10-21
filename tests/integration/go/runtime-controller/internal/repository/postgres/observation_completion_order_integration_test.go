package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

// Pause the actual completion transaction after INSERT allocated its sequence.
// The trigger is private to this disposable test schema, not a production hook.
func TestRepositoryCompletionAndHealthObservationOrder(t *testing.T) {
	testCompletionObservationConsumer(t, func(_ *testing.T, store *Repository) observationOrderReader {
		return func(ctx context.Context, after uint64, limit int) (observationOrderPage, error) {
			window, err := store.ListObservations(ctx, after, limit)
			page := observationOrderPage{Observations: window.Observations, NextSequence: after}
			if len(page.Observations) > 0 {
				page.NextSequence = page.Observations[len(page.Observations)-1].Sequence
			}
			return page, err
		}
	})
}

type observationOrderPage struct {
	Observations []deployment.Observation
	NextSequence uint64
}

type observationOrderReader func(context.Context, uint64, int) (observationOrderPage, error)

func testCompletionObservationConsumer(t *testing.T, reader func(*testing.T, *Repository) observationOrderReader) {
	t.Helper()
	store, database, _ := integrationRepository(t)
	read := reader(t, store)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	const gateKey int64 = 0x544553544f425356
	_, err := database.ExecContext(ctx, fmt.Sprintf(`
CREATE FUNCTION runtime_controller.hold_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'held_completion' THEN
    PERFORM pg_advisory_xact_lock(%d);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hold_completion AFTER INSERT ON runtime_controller.observations
FOR EACH ROW EXECUTE FUNCTION runtime_controller.hold_completion();`, gateKey))
	if err != nil {
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
	healthStore, healthPID := observationOrderWriter(t, ctx, store)
	var after uint64
	for round := range 100 {
		func() {
			now := time.Now().UTC()
			operation := integrationOperation(fmt.Sprintf("order-init-%d", round), deployment.OperationInitializeRuntime, now)
			operation.AgentID = fmt.Sprintf("order-agent-%d", round)
			operation.Transition = deployment.LifecycleInitializing
			started, _, err := store.BeginTransition(ctx, operation)
			if err != nil {
				t.Fatal(err)
			}
			started.State, started.Effect = deployment.OperationCompleted, deployment.EffectCompleted
			started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now)
			fact := deployment.Observation{AgentID: started.AgentID, RuntimeRevision: started.RuntimeRevision,
				Kind: deployment.ObservationInitialized, Source: "held_completion", ObservedAt: now}
			if _, err := gate.ExecContext(ctx, "SELECT pg_advisory_lock($1)", gateKey); err != nil {
				t.Fatal(err)
			}
			release := func() { _, _ = gate.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", gateKey) }
			defer release()
			completion := &orderAppendResult{}
			completed := make(chan struct{})
			go func() {
				defer close(completed)
				value, err := store.CompleteOperation(ctx, started, &fact)
				completion.err = err
				if value != nil {
					completion.value = *value
				}
			}()
			defer func() { release(); <-completed }()
			waitCtx, stopWait := context.WithTimeout(ctx, 5*time.Second)
			defer stopWait()
			for {
				var blocked bool
				if err := database.QueryRowContext(waitCtx, `SELECT EXISTS (
SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='advisory' AND $1 = ANY(pg_blocking_pids(pid)))`, gatePID).Scan(&blocked); err != nil {
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
				case <-time.After(time.Millisecond):
				}
			}
			health := fact
			health.Kind, health.Source = deployment.ObservationHealthy, "concurrent_health"
			health.Generation, health.SpecDigest = started.Generation, started.SpecDigest
			result, done := startOrderAppend(ctx, healthStore, health)
			defer func() { release(); <-done }()
			waitOrderWriter(t, ctx, database, healthPID, done)
			window, err := read(ctx, after, 2)
			if err != nil || len(window.Observations) != 0 || window.NextSequence != after {
				t.Fatalf("round %d: health overtook completion: %+v err=%v", round, window, err)
			}
			release()
			<-completed
			<-done
			if completion.err != nil || result.err != nil {
				t.Fatalf("writers: completion=%v health=%v", completion.err, result.err)
			}
			for _, want := range []deployment.Observation{completion.value, result.value} {
				page, err := read(ctx, after, 1)
				if err != nil || len(page.Observations) != 1 || page.NextSequence != want.Sequence || page.Observations[0].Sequence != want.Sequence || page.Observations[0].Kind != want.Kind || page.Observations[0].AgentID != started.AgentID || page.Observations[0].RuntimeRevision != started.RuntimeRevision {
					t.Fatalf("round %d: cursor skipped a committed fact: %+v want=%+v err=%v", round, page, want, err)
				}
				after = page.NextSequence
			}
		}()
	}
	t.Log("100 operation-completion/health races consumed all 200 facts with one-row pages")
}

func TestRepositoryObservationAppendThroughput(t *testing.T) {
	store, _, _ := integrationRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	const writers, perWriter = 8, 125
	start := make(chan struct{})
	done := make(chan error, writers)
	for writer := range writers {
		go func() {
			<-start
			for item := range perWriter {
				if _, err := store.AppendObservation(ctx, orderObservation(fmt.Sprintf("throughput-%d-%d", writer, item))); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
	}
	started := time.Now()
	close(start)
	for range writers {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
	elapsed := time.Since(started)
	var after uint64
	count := 0
	for {
		page, err := store.ListObservations(ctx, after, 500)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Observations) == 0 {
			break
		}
		count += len(page.Observations)
		after = page.Observations[len(page.Observations)-1].Sequence
	}
	if count != writers*perWriter {
		t.Fatalf("committed observations=%d want=%d", count, writers*perWriter)
	}
	t.Logf("append benchmark: writers=%d observations=%d elapsed=%s observations_per_second=%.2f", writers, count, elapsed, float64(count)/elapsed.Seconds())
}
