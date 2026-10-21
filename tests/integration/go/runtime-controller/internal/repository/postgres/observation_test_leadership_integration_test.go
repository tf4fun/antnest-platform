package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func observationTestEpoch(t *testing.T, store *Repository, ctx context.Context) repository.ObservationEpoch {
	t.Helper()
	lease, acquired, err := store.TryAcquireObservationLeadership(ctx)
	if err != nil || !acquired {
		t.Fatalf("acquire observation leadership: acquired=%t err=%v", acquired, err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := lease.Release(cleanup); err != nil {
			t.Errorf("release observation leadership: %v", err)
		}
	})
	return lease.Epoch()
}
