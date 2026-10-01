package control

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestStatusOnlyChecksLocalInitializationAndOwnStorage(t *testing.T) {
	store := &readinessStore{}
	service := &Service{repository: store, platform: readinessPlatform{}, observations: lifecycleObservationReadiness{}}
	status, err := service.Status(context.Background())
	if err != nil || !status.Ready() || store.calls != 1 {
		t.Fatalf("local readiness: %+v %v", status, err)
	}
	store.err = errors.New("own storage unavailable")
	status, err = service.Status(context.Background())
	if !errors.Is(err, store.err) || status.Ready() {
		t.Fatal("own storage failure was ignored")
	}
}

type readinessStore struct {
	repository.Store
	calls int
	err   error
}

func (r *readinessStore) Ready(context.Context) error { r.calls++; return r.err }

type readinessPlatform struct{ platform.Lifecycle }

func (readinessPlatform) Ready(context.Context) error { panic("status must not call Docker") }
