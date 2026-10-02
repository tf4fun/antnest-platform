package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/monitor"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestMonitorReconciliationRetriesChangeHTTPReadinessAndRecover(t *testing.T) {
	health := &observation.Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	store := &monitorReadinessStore{}
	service, err := control.NewService(store, store, health, monitorReadinessPlatform{},
		monitorReadinessVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newTestHandler(t, service))
	t.Cleanup(server.Close)
	client := &http.Client{Timeout: time.Second}
	source := &httpRetrySource{
		disconnect: make(chan struct{}), failures: make(chan struct{}), retry: make(chan struct{}),
	}
	runner, err := monitor.New(source, httpRetrySink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, 4*time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	ready := make(chan struct{}, 2)
	done := make(chan error, 1)
	go func() {
		done <- runner.RunCoordinated(ctx, httpRetryCoordinator{}, func() { ready <- struct{}{} })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("monitor shutdown: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("monitor goroutine did not stop")
		}
	})
	wait := func(signal <-chan struct{}) {
		t.Helper()
		select {
		case <-signal:
		case <-ctx.Done():
			t.Fatal("monitor recovery timed out")
		}
	}
	check := func(expected int) {
		t.Helper()
		response, err := client.Get(server.URL + "/status")
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := response.Body.Close(); err != nil {
				t.Error(err)
			}
		}()
		var body readinessResponse
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		wantReady := expected == http.StatusOK
		if response.StatusCode != expected || body.Ready != wantReady || body.MonitorReady != wantReady ||
			!body.Live || !body.DatabaseReady || !body.PlatformReady || !body.ObservationReady {
			t.Fatalf("HTTP %d during retry, want %d: %+v", response.StatusCode, expected, body)
		}
	}
	wait(ready)
	check(http.StatusOK)
	close(source.disconnect)
	for i := 0; i < 2; i++ {
		wait(source.failures)
		check(http.StatusServiceUnavailable)
		select {
		case source.retry <- struct{}{}:
		case <-ctx.Done():
			t.Fatal("monitor did not consume the controlled retry")
		}
	}
	wait(ready)
	check(http.StatusOK)
	if ctx.Err() != nil || source.lists != 4 {
		t.Fatalf("recovery skipped the two failed reconciliations: lists=%d ctx=%v", source.lists, ctx.Err())
	}
}

type httpRetrySource struct {
	disconnect chan struct{}
	failures   chan struct{}
	retry      chan struct{}
	lists      int
	watches    int
}

func (s *httpRetrySource) List(ctx context.Context) ([]deployment.Inspection, error) {
	s.lists++
	if s.lists == 2 || s.lists == 3 {
		select {
		case s.failures <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		select {
		case <-s.retry:
			return nil, errors.New("Docker inventory temporarily unavailable")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, nil
}

func (s *httpRetrySource) Watch(ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	s.watches++
	if err := ready(ctx); err != nil {
		return err
	}
	if s.watches == 1 {
		select {
		case <-s.disconnect:
			return errors.New("Docker Watch disconnected")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

type httpRetrySink struct{ monitor.Sink }

func (httpRetrySink) RecordPlatformObservation(_ context.Context, value deployment.Observation) (deployment.Observation, error) {
	return value, nil
}
func (httpRetrySink) ReconcileExpectedRuntimes(context.Context, []deployment.Inspection) error {
	return nil
}
func (httpRetrySink) ReconcileRetainedStorage(context.Context) error { return nil }

type httpRetryCoordinator struct {
	repository.ObservationCoordinator
}

func (httpRetryCoordinator) TryAcquireObservationLeadership(context.Context) (repository.Leadership, bool, error) {
	return httpRetryLeadership{done: make(chan struct{})}, true, nil
}

type httpRetryLeadership struct{ done chan struct{} }

func (l httpRetryLeadership) Done() <-chan struct{}                      { return l.done }
func (httpRetryLeadership) Err() error                                   { return nil }
func (httpRetryLeadership) MarkObservationReady(context.Context) error   { return nil }
func (httpRetryLeadership) MarkObservationUnready(context.Context) error { return nil }
func (l httpRetryLeadership) Release(context.Context) error {
	close(l.done)
	return nil
}
