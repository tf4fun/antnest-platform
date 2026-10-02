package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/monitor"
)

func TestRepositoryObservationMonitorRetryRecovery(t *testing.T) {
	repository, _, parent := integrationRepository(t)
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	health := &retryMonitorHealth{}
	source := &retryMonitorSource{repository: repository, health: health}
	runner, err := monitor.New(source, &retryMonitorSink{repository: repository}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), 5*time.Millisecond, 20*time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	readyCalls := 0
	err = runner.RunCoordinated(ctx, repository, func() {
		readyCalls++
		ready, probeErr := repository.ObservationMonitorReady(ctx)
		if probeErr != nil || !ready || !health.ready.Load() {
			t.Errorf("Watch handshake did not publish readiness: ready=%t local=%t err=%v", ready, health.ready.Load(), probeErr)
		}
		cancel()
	})
	if err != nil || readyCalls != 1 || source.lists != 3 {
		t.Fatalf("monitor retry did not recover: ready=%d lists=%d err=%v", readyCalls, source.lists, err)
	}
	ready, err := repository.ObservationMonitorReady(parent)
	if err != nil || ready {
		t.Fatalf("monitor shutdown leaked its shared readiness lease: ready=%t err=%v", ready, err)
	}
	lease, acquired, err := repository.TryAcquireObservationLeadership(parent)
	if err != nil || !acquired {
		t.Fatalf("reconciliation retry leaked leadership: acquired=%t err=%v", acquired, err)
	}
	if err := lease.Release(parent); err != nil {
		t.Fatal(err)
	}
	window, err := repository.ListObservations(parent, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	var gaps, reconciled int
	for _, value := range window.Observations {
		switch value.Kind {
		case deployment.ObservationGap:
			gaps++
		case deployment.ObservationReconciled:
			reconciled++
		}
	}
	if gaps != 3 || reconciled != 1 {
		t.Fatalf("failed attempts claimed completion: gaps=%d reconciled=%d", gaps, reconciled)
	}
}

type retryMonitorHealth struct{ ready atomic.Bool }

func (h *retryMonitorHealth) MarkMonitor(ready bool) { h.ready.Store(ready) }

type retryMonitorSource struct {
	repository *Repository
	health     *retryMonitorHealth
	lists      int
}

func (s *retryMonitorSource) List(ctx context.Context) ([]deployment.Inspection, error) {
	s.lists++
	ready, err := s.repository.ObservationMonitorReady(ctx)
	if err != nil || ready || s.health.ready.Load() {
		return nil, &monitor.PermanentError{Err: fmt.Errorf("monitor became ready before reconciliation/Watch: ready=%t err=%v", ready, err)}
	}
	if s.lists < 3 {
		return nil, errors.New("Docker socket temporarily unavailable")
	}
	return nil, nil
}

func (*retryMonitorSource) Watch(ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	if err := ready(ctx); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

type retryMonitorSink struct{ repository *Repository }

func (*retryMonitorSink) InspectPlatformRuntime(context.Context, deployment.Key) (deployment.Inspection, error) {
	return deployment.Inspection{}, errors.New("empty inventory does not inspect a Runtime")
}
func (*retryMonitorSink) ValidateRuntimeInspection(context.Context, deployment.Inspection) error {
	return nil
}
func (s *retryMonitorSink) RecordPlatformObservation(ctx context.Context, value deployment.Observation) (deployment.Observation, error) {
	return s.repository.AppendObservation(ctx, value)
}
func (*retryMonitorSink) ReconcileExpectedRuntimes(context.Context, []deployment.Inspection) error {
	return nil
}
func (*retryMonitorSink) ReconcileRetainedStorage(context.Context) error { return nil }
