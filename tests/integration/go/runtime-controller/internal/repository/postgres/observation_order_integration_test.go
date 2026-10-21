package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

// Each round holds the lower sequence uncommitted until another real writer
// either blocks in PostgreSQL or commits. No scheduling sleep stands in for
// proof that the competing transaction actually reached its append.
func TestRepositoryObservationCommitOrder(t *testing.T) {
	store, database, _ := integrationRepository(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	other, pid := observationOrderWriter(t, ctx, store)
	var after uint64
	for round := range 1000 {
		func() {
			tx, err := database.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback() }()
			first := orderObservation(fmt.Sprintf("first-%d", round))
			stored, err := store.storeObservation(ctx, tx, &first)
			if err != nil {
				t.Fatal(err)
			}
			result, done := startOrderAppend(ctx, other, orderObservation(fmt.Sprintf("second-%d", round)))
			defer func() { _ = tx.Rollback(); <-done }()
			waitOrderWriter(t, ctx, database, pid, done)
			window, err := store.ListObservations(ctx, after, 2)
			if err != nil {
				t.Fatal(err)
			}
			if len(window.Observations) != 0 || window.LatestSequence > after {
				t.Fatalf("round %d: page advanced past uncommitted sequence %d: %+v", round, stored.Sequence, window)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			<-done
			if result.err != nil {
				t.Fatal(result.err)
			}
			window, err = store.ListObservations(ctx, after, 2)
			if err != nil || len(window.Observations) != 2 ||
				window.Observations[0].Sequence != stored.Sequence ||
				window.Observations[1].Sequence != result.value.Sequence ||
				stored.Sequence >= result.value.Sequence {
				t.Fatalf("round %d: committed facts were skipped/reordered: %+v err=%v", round, window, err)
			}
			after = result.value.Sequence
		}()
	}
	t.Log("1000 held-transaction races reconstructed 2000 committed observations")
}

func TestRepositoryObservationRollbackReleasesOrder(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	other, pid := observationOrderWriter(t, ctx, store)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	first := orderObservation("rolled-back")
	aborted, err := store.storeObservation(ctx, tx, &first)
	if err != nil {
		t.Fatal(err)
	}
	result, done := startOrderAppend(ctx, other, orderObservation("committed"))
	defer func() { _ = tx.Rollback(); <-done }()
	waitOrderWriter(t, ctx, database, pid, done)
	select {
	case <-done:
		t.Fatal("later writer committed before earlier transaction resolved")
	default:
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	<-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 1 || window.Observations[0].Source != "committed" || result.value.Sequence <= aborted.Sequence {
		t.Fatalf("rollback must leave a permanent gap and release the next writer: %+v err=%v", window, err)
	}
}

func TestRepositoryObservationOrderWaitCancellation(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	other, pid := observationOrderWriter(t, ctx, store)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	first := orderObservation("held")
	if _, err := store.storeObservation(ctx, tx, &first); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	result, done := startOrderAppend(waitCtx, other, orderObservation("cancelled"))
	defer func() { cancel(); _ = tx.Rollback(); <-done }()
	waitOrderWriter(t, ctx, database, pid, done)
	cancel()
	<-done
	if result.err == nil {
		t.Fatal("cancelled lock wait appended an observation")
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := other.AppendObservation(ctx, orderObservation("after-cancellation")); err != nil {
		t.Fatal(err)
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 2 || window.Observations[0].Source != "held" || window.Observations[1].Source != "after-cancellation" {
		t.Fatalf("cancelled append leaked a row or lock: %+v err=%v", window, err)
	}
}

func orderObservation(source string) deployment.Observation {
	return deployment.Observation{Kind: deployment.ObservationReconciled, Source: source, ObservedAt: time.Now().UTC()}
}

type orderAppendResult struct {
	value deployment.Observation
	err   error
}

func startOrderAppend(ctx context.Context, store *Repository, value deployment.Observation) (*orderAppendResult, <-chan struct{}) {
	result := &orderAppendResult{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		result.value, result.err = store.AppendObservation(ctx, value)
	}()
	return result, done
}

func observationOrderWriter(t *testing.T, ctx context.Context, store *Repository) (*Repository, int) {
	t.Helper()
	u, err := url.Parse(os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("application_name", "observation-order-writer")
	u.RawQuery = q.Encode()
	database, err := OpenDatabase(ctx, u.String(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	var pid int
	if err := database.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	other, err := New(database, store.lockDatabase, store.retention)
	if err != nil {
		t.Fatal(err)
	}
	return other, pid
}

func waitOrderWriter(t *testing.T, ctx context.Context, database *sql.DB, pid int, done <-chan struct{}) {
	t.Helper()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := database.QueryRowContext(waitCtx,
			`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)`, pid,
		).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-done:
			return
		case <-waitCtx.Done():
			t.Fatal("competing writer neither completed nor reached its PostgreSQL lock")
		case <-time.After(time.Millisecond):
		}
	}
}
