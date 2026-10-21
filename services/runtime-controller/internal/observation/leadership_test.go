package observation

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestStaleEpochDoesNotPoisonJournalHealthOrNotify(t *testing.T) {
	health := &Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	hub := NewHub()
	signals, cancel := hub.Subscribe()
	defer cancel()
	base := &fakeRepository{appendErr: repository.ErrLeadershipLost}
	store, err := NewRepository(base, hub, health)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendObservation(context.Background(), 7, deployment.Observation{}); !errors.Is(err, repository.ErrLeadershipLost) {
		t.Fatalf("lost leadership error: %v", err)
	}
	if err := health.ObservationReady(); err != nil {
		t.Fatalf("stale writer poisoned shared journal health: %v", err)
	}
	select {
	case <-signals:
		t.Fatal("rejected epoch published a wakeup")
	default:
	}
}
