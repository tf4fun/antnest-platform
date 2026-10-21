package monitor

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestObservationEpochReconcileForwardsEverySinkPath(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	sink := &observationEpochSink{}
	runner := newTestRunner(t, &fakeSource{}, sink)
	if err := runner.Reconcile(ctx, 42, true); err != nil {
		t.Fatal(err)
	}
	if want := []repository.ObservationEpoch{42, 42}; !reflect.DeepEqual(sink.recordedEpochs, want) {
		t.Errorf("recorded observation epochs = %v, want %v", sink.recordedEpochs, want)
	}
	if want := []repository.ObservationEpoch{42}; !reflect.DeepEqual(sink.expectedEpochs, want) {
		t.Errorf("expected Runtime reconciliation epochs = %v, want %v", sink.expectedEpochs, want)
	}
	if want := []repository.ObservationEpoch{42}; !reflect.DeepEqual(sink.storageEpochs, want) {
		t.Errorf("retained storage reconciliation epochs = %v, want %v", sink.storageEpochs, want)
	}
	if len(sink.values) != 2 || sink.values[0].Kind != deployment.ObservationGap ||
		sink.values[1].Kind != deployment.ObservationReconciled {
		t.Fatalf("gap reconciliation observations = %+v", sink.values)
	}
}

type observationEpochSink struct {
	fakeSink
	recordedEpochs []repository.ObservationEpoch
	expectedEpochs []repository.ObservationEpoch
	storageEpochs  []repository.ObservationEpoch
}

func (s *observationEpochSink) RecordPlatformObservation(
	ctx context.Context, epoch repository.ObservationEpoch, value deployment.Observation,
) (deployment.Observation, error) {
	s.recordedEpochs = append(s.recordedEpochs, epoch)
	return s.fakeSink.RecordPlatformObservation(ctx, epoch, value)
}

func (s *observationEpochSink) ReconcileExpectedRuntimes(
	ctx context.Context, epoch repository.ObservationEpoch, inspections []deployment.Inspection,
) error {
	s.expectedEpochs = append(s.expectedEpochs, epoch)
	return s.fakeSink.ReconcileExpectedRuntimes(ctx, epoch, inspections)
}

func (s *observationEpochSink) ReconcileRetainedStorage(
	ctx context.Context, epoch repository.ObservationEpoch,
) error {
	s.storageEpochs = append(s.storageEpochs, epoch)
	return s.fakeSink.ReconcileRetainedStorage(ctx, epoch)
}

func TestObservationEpochRunReturnsLeadershipLostWithoutRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	source := &observationLeadershipLostSource{}
	runner := newTestRunner(t, source, &fakeSink{})
	waits := 0
	runner.wait = func(context.Context, time.Duration) bool {
		waits++
		return false
	}
	ready := func(context.Context) error { return nil }
	err := runner.Run(ctx, 42, time.Now(), ready, ready)
	if !errors.Is(err, repository.ErrLeadershipLost) {
		t.Errorf("Run error = %v, want leadership loss", err)
	}
	if source.watches != 1 || source.lists != 0 || waits != 0 {
		t.Errorf("leadership loss retried: Watch calls=%d, List calls=%d, waits=%d",
			source.watches, source.lists, waits)
	}
}

type observationLeadershipLostSource struct {
	fakeSource
	watches int
	lists   int
}

func (s *observationLeadershipLostSource) List(ctx context.Context) ([]deployment.Inspection, error) {
	s.lists++
	return s.fakeSource.List(ctx)
}

func (s *observationLeadershipLostSource) Watch(
	ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	s.watches++
	if err := ready(ctx); err != nil {
		return err
	}
	return repository.ErrLeadershipLost
}
