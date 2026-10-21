package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestObservationEpochRejectsMissingAndStaleWriters(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	epoch := observationTestEpoch(t, store, ctx)
	if epoch <= 0 {
		t.Fatalf("invalid acquired epoch: %d", epoch)
	}
	if _, err := store.AppendObservation(ctx, 0, orderObservation("missing-epoch")); !errors.Is(err, repository.ErrLeadershipLost) {
		t.Fatalf("missing epoch was admitted: %v", err)
	}
	var next repository.ObservationEpoch
	if err := database.QueryRowContext(ctx, `UPDATE runtime_controller.observation_leader SET epoch=epoch+1 WHERE id=1 RETURNING epoch`).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if next <= epoch {
		t.Fatalf("epoch did not advance: %d -> %d", epoch, next)
	}
	if _, err := store.AppendObservation(ctx, epoch, orderObservation("stale-epoch")); !errors.Is(err, repository.ErrLeadershipLost) {
		t.Fatalf("stale epoch was admitted: %v", err)
	}
	if _, err := store.PruneObservationBatch(ctx, epoch); !errors.Is(err, repository.ErrLeadershipLost) {
		t.Fatalf("stale pruner was admitted: %v", err)
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 0 {
		t.Fatalf("rejected writes became visible: %+v err=%v", window, err)
	}
	if _, err := store.AppendObservation(ctx, next, orderObservation("current-epoch")); err != nil {
		t.Fatal(err)
	}
}

func TestObservationLeadershipAcquisitionAdvancesEpoch(t *testing.T) {
	store, _, ctx := integrationRepository(t)
	first, acquired, err := store.TryAcquireObservationLeadership(ctx)
	if err != nil || !acquired {
		t.Fatalf("first lease: %t %v", acquired, err)
	}
	old := first.Epoch()
	if err := first.Release(ctx); err != nil {
		t.Fatal(err)
	}
	next := observationTestEpoch(t, store, ctx)
	if old <= 0 || next <= old {
		t.Fatalf("non-monotonic leadership epochs: %d -> %d", old, next)
	}
}

func TestObservationEpochBumpWaitsForInflightWriter(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	epoch := observationTestEpoch(t, store, ctx)
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := verifyObservationEpoch(ctx, tx, epoch); err != nil {
		t.Fatal(err)
	}
	value := orderObservation("old-term-inflight")
	if _, err := store.storeObservation(ctx, tx, &value); err != nil {
		t.Fatal(err)
	}
	connection, err := database.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close() }()
	var pid int
	if err := connection.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	var next repository.ObservationEpoch
	var bumpErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		bumpErr = connection.QueryRowContext(ctx, `UPDATE runtime_controller.observation_leader SET epoch=epoch+1 WHERE id=1 RETURNING epoch`).Scan(&next)
	}()
	defer func() { _ = tx.Rollback(); <-done }()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var blocked bool
		if err := database.QueryRowContext(waitCtx, "SELECT cardinality(pg_blocking_pids($1)) > 0", pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-done:
			t.Fatalf("new epoch overtook uncommitted old writer: %v", bumpErr)
		case <-waitCtx.Done():
			t.Fatal(waitCtx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	<-done
	if bumpErr != nil || next <= epoch {
		t.Fatalf("new epoch after commit: %d %v", next, bumpErr)
	}
	if _, err := store.AppendObservation(ctx, epoch, orderObservation("old-after-new")); !errors.Is(err, repository.ErrLeadershipLost) {
		t.Fatalf("old epoch accepted: %v", err)
	}
	if _, err := store.AppendObservation(ctx, next, orderObservation("new-term")); err != nil {
		t.Fatal(err)
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 2 || window.Observations[0].Source != "old-term-inflight" || window.Observations[1].Source != "new-term" {
		t.Fatalf("fenced history: %+v err=%v", window, err)
	}
}

func TestObservationPrunerBoundsBatchesAndAllowsTemporaryOvershoot(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	epoch := observationTestEpoch(t, store, ctx)
	store.maxObservationRows = 3
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (agent_id,runtime_revision,generation,spec_digest,kind,source,observed_at)
SELECT '', '', 0, '', 'reconciled', 'count-fixture', NOW() FROM generate_series(1,2505)`); err != nil {
		t.Fatal(err)
	}
	for _, want := range []int64{1000, 1000, 502, 0} {
		count, err := store.PruneObservationBatch(ctx, epoch)
		if err != nil || count != want {
			t.Fatalf("pruned %d, want %d: %v", count, want, err)
		}
	}
	window, err := store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 3 || window.PrunedThrough != 2502 || window.OldestSequence != 2503 || window.LatestSequence != 2505 {
		t.Fatalf("bounded journal: %+v err=%v", window, err)
	}
	if _, err := store.AppendObservation(ctx, epoch, orderObservation("temporary-overshoot")); err != nil {
		t.Fatal(err)
	}
	window, err = store.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 4 {
		t.Fatalf("append pruned inline: %+v err=%v", window, err)
	}
	if count, err := store.PruneObservationBatch(ctx, epoch); err != nil || count != 1 {
		t.Fatalf("overshoot did not converge: %d %v", count, err)
	}
}

func TestObservationAgePruningPreservesPrefixAndEmptyFloor(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	epoch := observationTestEpoch(t, store, ctx)
	// Non-monotonic recorded_at can come from a transaction started before a
	// prior committer. Prune through the last expired row, never punch a hole.
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (sequence,agent_id,runtime_revision,generation,spec_digest,kind,source,observed_at,recorded_at)
VALUES (10,'','',0,'','reconciled','recent-prefix',NOW(),NOW()),
       (20,'','',0,'','reconciled','expired-middle',NOW(),NOW()-INTERVAL '2 hours'),
       (30,'','',0,'','reconciled','retained',NOW(),NOW())`); err != nil {
		t.Fatal(err)
	}
	if count, err := store.PruneObservationBatch(ctx, epoch); err != nil || count != 2 {
		t.Fatalf("age prefix: %d %v", count, err)
	}
	window, err := store.ListObservations(ctx, 20, 10)
	if err != nil || len(window.Observations) != 1 || window.PrunedThrough != 20 || window.OldestSequence != 30 || window.LatestSequence != 30 {
		t.Fatalf("rollback gaps changed the floor: %+v err=%v", window, err)
	}
	if _, err := database.ExecContext(ctx, "UPDATE runtime_controller.observations SET recorded_at=NOW()-INTERVAL '2 hours'"); err != nil {
		t.Fatal(err)
	}
	if count, err := store.PruneObservationBatch(ctx, epoch); err != nil || count != 1 {
		t.Fatalf("empty prune: %d %v", count, err)
	}
	window, err = store.ListObservations(ctx, 30, 10)
	if err != nil || len(window.Observations) != 0 || window.PrunedThrough != 30 || window.OldestSequence != 0 || window.LatestSequence != 30 {
		t.Fatalf("empty window forgot committed history: %+v err=%v", window, err)
	}
}
