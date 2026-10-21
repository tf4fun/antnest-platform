package monitor

import (
	"context"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestCoordinatedLeaderCancelsAndJoinsPrunerBeforeReleasingLeadership(t *testing.T) {
	pruner := &blockingObservationPruner{
		t: t, entered: make(chan struct{}), finished: make(chan struct{}),
	}
	lease := &prunerJoinLeadership{
		fakeLeadership: newFakeLeadership(), t: t, finished: pruner.finished,
	}
	coordinator := &prunerJoinCoordinator{lease: lease}
	source := &blockingSource{started: make(chan struct{})}
	runner := newTestRunner(t, source, &fakeSink{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		result <- runner.RunCoordinated(ctx, coordinator, pruner, time.Minute, func() {})
	}()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("monitor goroutine did not stop after cancellation")
		}
	}()
	select {
	case <-pruner.entered:
	case <-time.After(time.Second):
		t.Fatal("leader did not start observation pruning")
	}
	cancel()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("monitor cancellation failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("monitor did not join observation pruning after cancellation")
	}
	if lease.releases.Load() != 1 {
		t.Fatalf("leadership released %d times, want 1", lease.releases.Load())
	}
}

type blockingObservationPruner struct {
	t        *testing.T
	entered  chan struct{}
	finished chan struct{}
}

func (p *blockingObservationPruner) PruneObservationBatch(
	ctx context.Context, epoch repository.ObservationEpoch,
) (int64, error) {
	if epoch != 7 {
		p.t.Errorf("observation pruning epoch = %d, want 7", epoch)
	}
	close(p.entered)
	<-ctx.Done()
	close(p.finished)
	return 0, ctx.Err()
}

type prunerJoinLeadership struct {
	*fakeLeadership
	t        *testing.T
	finished <-chan struct{}
}

func (l *prunerJoinLeadership) Release(ctx context.Context) error {
	select {
	case <-l.finished:
	default:
		l.t.Error("leadership was released before observation pruning finished")
	}
	return l.fakeLeadership.Release(ctx)
}

type prunerJoinCoordinator struct {
	lease repository.Leadership
}

func (c *prunerJoinCoordinator) TryAcquireObservationLeadership(
	context.Context,
) (repository.Leadership, bool, error) {
	return c.lease, true, nil
}

func (*prunerJoinCoordinator) ObservationMonitorReady(context.Context) (bool, error) {
	return false, nil
}
