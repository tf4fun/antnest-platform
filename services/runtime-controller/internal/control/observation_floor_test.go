package control

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type observationFloorRepository struct {
	*lifecycleRepository
	window deployment.ObservationWindow
}

func (r *observationFloorRepository) ListObservations(context.Context, uint64, int) (deployment.ObservationWindow, error) {
	return r.window, nil
}

func TestObservationExpiryUsesPrunedFactsNotSequenceGaps(t *testing.T) {
	for _, test := range []struct {
		name                         string
		after, floor, oldest, latest uint64
		expired                      bool
	}{
		{"rollback gap after floor", 10, 10, 20, 30, false},
		{"unpruned initial gap", 4, 0, 20, 30, false},
		{"unconsumed pruned fact", 9, 10, 20, 30, true},
		{"empty fully consumed", 30, 30, 0, 30, false},
		{"empty lost history", 29, 30, 0, 30, true},
		{"empty bootstrap", 0, 30, 0, 30, false},
		{"empty reset", 1, 0, 0, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &observationFloorRepository{lifecycleRepository: newLifecycleRepository(), window: deployment.ObservationWindow{
				PrunedThrough: test.floor, OldestSequence: test.oldest, LatestSequence: test.latest,
			}}
			service := newLifecycleService(t, store.lifecycleRepository, newLifecyclePlatform())
			service.repository = store
			_, err := service.ListObservations(context.Background(), test.after, 10)
			var expired *ObservationCursorExpiredError
			if test.expired {
				if !errors.As(err, &expired) || expired.ResetSequence != test.latest {
					t.Fatalf("expiry = %v, want reset %d", err, test.latest)
				}
			} else if err != nil {
				t.Fatalf("valid cursor rejected: %v", err)
			}
		})
	}
}
