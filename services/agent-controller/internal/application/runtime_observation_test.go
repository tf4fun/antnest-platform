package application

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeObservationWorkerBootstrapsBeforeApplyingJournal(t *testing.T) {
	source := &runtimeObservationSourceStub{
		runtimes: []ports.RuntimeEnvironmentSnapshot{{
			AgentID: "agent-1", RuntimeRevision: "runtime-1", RuntimeExecutionID: "execution-2",
		}},
		pages: []ports.RuntimeObservationPage{{
			Observations: []ports.RuntimeObservation{{
				Sequence: 7, AgentID: "agent-1", RuntimeRevision: "runtime-1",
				Kind: ports.RuntimeObservationRestarted, ObservedAt: time.Now().UTC(),
			}},
			NextSequence: 7,
		}},
	}
	store := &runtimeObservationStoreStub{}
	worker := newRuntimeObservationWorkerForTest(t, source, store)
	if err := worker.synchronize(context.Background()); err != nil {
		t.Fatalf("synchronize: %v", err)
	}
	if store.initializeCalls != 1 || len(store.applied) != 1 || store.applied[0].Sequence != 7 {
		t.Fatalf("initialize=%d applied=%#v", store.initializeCalls, store.applied)
	}
	if len(source.after) != 1 || source.after[0] != 0 {
		t.Fatalf("observation cursors=%v", source.after)
	}
}

func TestRuntimeObservationWorkerReconcilesExpiredCursor(t *testing.T) {
	source := &runtimeObservationSourceStub{
		runtimes: []ports.RuntimeEnvironmentSnapshot{{AgentID: "agent-1"}},
		pageErrors: []error{
			&ports.RuntimeObservationCursorExpiredError{ResetSequence: 41}, nil,
		},
		pages: []ports.RuntimeObservationPage{{NextSequence: 41}},
	}
	store := &runtimeObservationStoreStub{
		cursor: ports.RuntimeObservationCursor{Sequence: 10, Initialized: true},
	}
	worker := newRuntimeObservationWorkerForTest(t, source, store)
	if err := worker.synchronize(context.Background()); err != nil {
		t.Fatalf("synchronize: %v", err)
	}
	if store.resetSequence != 41 || len(source.after) != 2 || source.after[1] != 41 {
		t.Fatalf("reset=%d cursors=%v", store.resetSequence, source.after)
	}
}

func TestRuntimeObservationWorkerDoesNotAdvanceAfterStoreFailure(t *testing.T) {
	source := &runtimeObservationSourceStub{pages: []ports.RuntimeObservationPage{{
		Observations: []ports.RuntimeObservation{{Sequence: 2}}, NextSequence: 2,
	}}}
	store := &runtimeObservationStoreStub{
		cursor:   ports.RuntimeObservationCursor{Sequence: 1, Initialized: true},
		applyErr: errors.New("database unavailable"),
	}
	worker := newRuntimeObservationWorkerForTest(t, source, store)
	if err := worker.synchronize(context.Background()); err == nil {
		t.Fatal("store failure was ignored")
	}
	if len(store.applied) != 0 {
		t.Fatalf("failed observation was recorded as applied: %#v", store.applied)
	}
}

func newRuntimeObservationWorkerForTest(
	t *testing.T, source ports.RuntimeObservationSource, store ports.RuntimeObservationStore,
) *RuntimeObservationWorker {
	t.Helper()
	worker, err := NewRuntimeObservationWorker(
		source, store, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("NewRuntimeObservationWorker: %v", err)
	}
	return worker
}

type runtimeObservationSourceStub struct {
	runtimes   []ports.RuntimeEnvironmentSnapshot
	pages      []ports.RuntimeObservationPage
	pageErrors []error
	after      []uint64
}

func (source *runtimeObservationSourceStub) ListRuntimeObservations(
	_ context.Context, after uint64, _ int,
) (ports.RuntimeObservationPage, error) {
	source.after = append(source.after, after)
	if len(source.pageErrors) > 0 {
		err := source.pageErrors[0]
		source.pageErrors = source.pageErrors[1:]
		if err != nil {
			return ports.RuntimeObservationPage{}, err
		}
	}
	if len(source.pages) == 0 {
		return ports.RuntimeObservationPage{NextSequence: after}, nil
	}
	page := source.pages[0]
	source.pages = source.pages[1:]
	return page, nil
}

func (source *runtimeObservationSourceStub) ListRuntimes(
	context.Context,
) ([]ports.RuntimeEnvironmentSnapshot, error) {
	return source.runtimes, nil
}

type runtimeObservationStoreStub struct {
	cursor          ports.RuntimeObservationCursor
	initializeCalls int
	resetSequence   uint64
	applied         []ports.RuntimeObservation
	applyErr        error
}

func (store *runtimeObservationStoreStub) GetRuntimeObservationCursor(
	context.Context,
) (ports.RuntimeObservationCursor, error) {
	return store.cursor, nil
}

func (store *runtimeObservationStoreStub) InitializeRuntimeObservationCursor(
	_ context.Context, _ []ports.RuntimeEnvironmentSnapshot,
) error {
	store.initializeCalls++
	store.cursor.Initialized = true
	return nil
}

func (store *runtimeObservationStoreStub) ResetRuntimeObservationCursor(
	_ context.Context, _ []ports.RuntimeEnvironmentSnapshot, sequence uint64,
) error {
	store.resetSequence = sequence
	store.cursor = ports.RuntimeObservationCursor{Sequence: sequence, Initialized: true}
	return nil
}

func (store *runtimeObservationStoreStub) ApplyRuntimeObservation(
	_ context.Context, observation ports.RuntimeObservation,
) error {
	if store.applyErr != nil {
		return store.applyErr
	}
	store.applied = append(store.applied, observation)
	store.cursor.Sequence = observation.Sequence
	return nil
}
