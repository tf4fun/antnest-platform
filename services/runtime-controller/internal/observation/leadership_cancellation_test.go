package observation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestCancelledLeaderAppendDoesNotPoisonJournalHealthOrNotify(t *testing.T) {
	health := &Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	hub := NewHub()
	signals, unsubscribe := hub.Subscribe()
	defer unsubscribe()
	base := &cancelledLeaderRepository{fakeRepository: &fakeRepository{}, entered: make(chan struct{})}
	store, err := NewRepository(base, hub, health)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	var appendErr error
	go func() {
		defer close(done)
		_, appendErr = store.AppendObservation(ctx, 7, deployment.Observation{})
	}()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("cancelled leader append goroutine did not stop")
		}
	}()
	select {
	case <-base.entered:
	case <-time.After(time.Second):
		t.Fatal("leader append did not enter the repository")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("leader append did not return after caller cancellation")
	}
	if !errors.Is(appendErr, context.Canceled) {
		t.Fatalf("cancelled leader append error = %v, want context.Canceled", appendErr)
	}
	if err := health.ObservationReady(); err != nil {
		t.Errorf("cancelled leader request poisoned journal health: %v", err)
	}
	select {
	case <-signals:
		t.Error("cancelled leader append published a wakeup")
	default:
	}
}

type cancelledLeaderRepository struct {
	*fakeRepository
	entered chan struct{}
}

func (r *cancelledLeaderRepository) AppendObservation(
	ctx context.Context, _ repository.ObservationEpoch, _ deployment.Observation,
) (deployment.Observation, error) {
	close(r.entered)
	select {
	case <-ctx.Done():
		return deployment.Observation{}, ctx.Err()
	case <-time.After(time.Second):
		return deployment.Observation{}, errors.New("leader append did not observe caller cancellation")
	}
}
