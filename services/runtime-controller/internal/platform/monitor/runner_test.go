package monitor

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
)

const testSpecDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestReconcilePublishesVerifiedHealthyExecution(t *testing.T) {
	source := &fakeSource{inspections: []deployment.Inspection{{
		AgentID: "agent-1", Generation: 7, PlatformPhase: deployment.PhaseRunning,
		Health: deployment.HealthHealthy, PlatformResourceID: "container-1", SpecDigest: testSpecDigest,
	}}}
	sink := &fakeSink{}
	runner := newTestRunner(t, source, sink)
	if err := runner.Reconcile(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(sink.values) != 2 || sink.values[0].Kind != deployment.ObservationHealthy ||
		sink.values[0].RuntimeExecutionID != "execution-1" {
		t.Fatalf("healthy Runtime was not verified: %+v", sink.values)
	}
	if sink.storageReconciliations != 1 {
		t.Fatalf("retained storage reconciliations = %d, want 1", sink.storageReconciliations)
	}
	if sink.expectedReconciliations != 1 {
		t.Fatalf("expected Runtime reconciliations = %d, want 1", sink.expectedReconciliations)
	}
}

func TestReconcileStopsBeforeCompletionWhenRetainedStorageCannotBeVerified(t *testing.T) {
	sink := &fakeSink{storageErr: errors.New("workspace inventory unavailable")}
	health := &fakeHealth{}
	runner, err := New(&fakeSource{}, sink, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Reconcile(context.Background(), false); err == nil {
		t.Fatal("failed retained storage reconciliation was accepted")
	}
	if health.healthy || len(sink.values) != 0 {
		t.Fatalf("failed storage reconciliation advanced state: health=%t values=%+v",
			health.healthy, sink.values)
	}
}

func TestReconcileDoesNotDeclareWatchReadyBeforeHandshake(t *testing.T) {
	health := &fakeHealth{}
	runner, err := New(&fakeSource{}, &fakeSink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Reconcile(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if health.healthy {
		t.Fatal("inventory reconciliation was mistaken for an active platform Watch")
	}
}

func TestReconcileStopsWhenExpectedRuntimeInventoryCannotConverge(t *testing.T) {
	sink := &fakeSink{expectedErr: errors.New("logical inventory unavailable")}
	runner := newTestRunner(t, &fakeSource{}, sink)
	if err := runner.Reconcile(context.Background(), false); err == nil {
		t.Fatal("failed logical inventory reconciliation was accepted")
	}
	if len(sink.values) != 0 {
		t.Fatalf("failed logical reconciliation emitted completion: %+v", sink.values)
	}
}

func TestGapReconciliationRecordsGapBeforeCurrentFact(t *testing.T) {
	source := &fakeSource{inspections: []deployment.Inspection{{
		AgentID: "agent-1", Generation: 7, PlatformPhase: deployment.PhaseExited,
		Health: deployment.HealthUnknown, PlatformResourceID: "container-1", SpecDigest: testSpecDigest,
	}}}
	sink := &fakeSink{}
	runner := newTestRunner(t, source, sink)
	if err := runner.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if len(sink.values) != 3 || sink.values[0].Kind != deployment.ObservationGap ||
		sink.values[1].Kind != deployment.ObservationExited ||
		sink.values[2].Kind != deployment.ObservationReconciled {
		t.Fatalf("gap recovery ordering = %+v", sink.values)
	}
}

func TestHealthyEventBecomesUnverifiedWhenStatusCannotBeVerified(t *testing.T) {
	sink := &fakeSink{inspectErr: errors.Join(deployment.ErrStatusUnverified, errors.New("status mismatch"))}
	runner := newTestRunner(t, &fakeSource{}, sink)
	err := runner.record(context.Background(), deployment.Observation{
		AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationHealthy,
		SpecDigest: testSpecDigest, Source: "docker_event", ObservedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.values) != 1 || sink.values[0].Kind != deployment.ObservationStatusUnverified ||
		sink.values[0].DiagnosticSummary != "Runtime status could not be verified" {
		t.Fatalf("status failure was hidden: %+v", sink.values)
	}
}

func TestHealthyEventDoesNotHidePlatformOrClaimFailureAsStatusUnverified(t *testing.T) {
	sink := &fakeSink{inspectErr: errors.New("platform inspection failed")}
	runner := newTestRunner(t, &fakeSource{}, sink)
	err := runner.record(context.Background(), deployment.Observation{
		AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationHealthy,
		SpecDigest: testSpecDigest, Source: "docker_event", ObservedAt: time.Now(),
	})
	if err == nil || len(sink.values) != 0 {
		t.Fatalf("platform inspection failure was collapsed: err=%v values=%+v", err, sink.values)
	}
}

func TestHealthyEventTraceCarriesVerifiedRuntimeIdentity(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := monitorTracer
	monitorTracer = provider.Tracer("runtime-controller-monitor-test")
	t.Cleanup(func() {
		monitorTracer = original
		_ = provider.Shutdown(context.Background())
	})
	runner := newTestRunner(t, &fakeSource{}, &fakeSink{})
	if err := runner.record(context.Background(), deployment.Observation{
		AgentID: "agent-1", Generation: 7, Kind: deployment.ObservationHealthy,
		SpecDigest: testSpecDigest, Source: "docker_event", ObservedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	attributes := make(map[attribute.Key]attribute.Value)
	for _, value := range spans[0].Attributes() {
		attributes[value.Key] = value.Value
	}
	for key, want := range map[attribute.Key]string{
		"antnest.observation.kind":             string(deployment.ObservationHealthy),
		"antnest.runtime.spec_digest":          testSpecDigest,
		"antnest.runtime.platform_resource_id": "container-1",
		"antnest.runtime.execution_id":         "execution-1",
	} {
		if got := attributes[key].AsString(); got != want {
			t.Fatalf("span attribute %s = %q, want %q", key, got, want)
		}
	}
}

func TestGapReconciliationIsVisibleWhenInventoryIsEmpty(t *testing.T) {
	sink := &fakeSink{}
	runner := newTestRunner(t, &fakeSource{}, sink)
	if err := runner.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if len(sink.values) != 2 || sink.values[0].Kind != deployment.ObservationGap ||
		sink.values[1].Kind != deployment.ObservationReconciled ||
		sink.values[0].AgentID != "" || sink.values[0].Generation != 0 {
		t.Fatalf("empty-inventory gap was lost: %+v", sink.values)
	}
}

func TestReconcileDoesNotDeclareMalformedOrUnclaimedInventoryConverged(t *testing.T) {
	source := &fakeSource{inspections: []deployment.Inspection{{
		AgentID: "agent-1", Generation: 7, SpecDigest: "sha256:unexpected",
		PlatformPhase: deployment.PhaseExited, Health: deployment.HealthUnknown,
	}}}
	sink := &fakeSink{validateErr: errors.New("generation claim mismatch")}
	health := &fakeHealth{}
	runner, err := New(source, sink, health, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Reconcile(context.Background(), false); err == nil {
		t.Fatal("invalid managed inventory was declared reconciled")
	}
	if health.healthy || len(sink.values) != 0 {
		t.Fatalf("invalid inventory advanced reconciliation: health=%t values=%+v", health.healthy, sink.values)
	}
}

func TestCoordinatedFollowerIsReadyOnlyWhenLeaderWatchIsReady(t *testing.T) {
	health := &fakeHealth{}
	runner, err := New(&fakeSource{}, &fakeSink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ready := false
	err = runner.RunCoordinated(ctx, &fakeCoordinator{monitorReady: true}, func() {
		ready = true
		cancel()
	})
	if err != nil || !ready || !health.healthy {
		t.Fatalf("follower coordination = ready:%t healthy:%t err:%v", ready, health.healthy, err)
	}
}

func TestCoordinatedFollowerDoesNotPublishReadinessForUnreadyLeader(t *testing.T) {
	health := &fakeHealth{}
	runner, err := New(&fakeSource{}, &fakeSink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	ready := false
	err = runner.RunCoordinated(ctx, &fakeCoordinator{}, func() { ready = true })
	if err != nil || ready || health.healthy {
		t.Fatalf("unready leader leaked readiness: ready=%t healthy=%t err=%v", ready, health.healthy, err)
	}
}

func TestCoordinatedLeaderCancelsWatchAndReelectsAfterLeaseLoss(t *testing.T) {
	lease := newFakeLeadership()
	source := &blockingSource{started: make(chan struct{})}
	health := &recordingHealth{}
	runner, err := New(source, &fakeSink{}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	coordinator := &sequenceCoordinator{lease: lease}
	ctx, cancel := context.WithCancel(context.Background())
	readyCalls := atomic.Int32{}
	result := make(chan error, 1)
	go func() {
		result <- runner.RunCoordinated(ctx, coordinator, func() {
			if readyCalls.Add(1) == 2 {
				cancel()
			}
		})
	}()
	select {
	case <-source.started:
	case <-time.After(time.Second):
		t.Fatal("leader did not start platform Watch")
	}
	lease.lose(errors.New("leadership database session was lost"))
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("leadership loss did not recover: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("leadership loss did not cancel Watch and trigger re-election")
	}
	if coordinator.calls.Load() < 2 {
		t.Fatalf("leadership was not re-elected: calls=%d", coordinator.calls.Load())
	}
	if lease.releases.Load() != 1 {
		t.Fatalf("lost leadership was not released exactly once: %d", lease.releases.Load())
	}
	if !health.sawUnhealthy() {
		t.Fatal("monitor readiness was not lowered after leadership loss")
	}
}

func newTestRunner(t *testing.T, source platform.ObservationSource, sink Sink) *Runner {
	t.Helper()
	runner, err := New(source, sink, &fakeHealth{}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

type fakeHealth struct{ healthy bool }

func (h *fakeHealth) MarkMonitor(healthy bool) { h.healthy = healthy }

type recordingHealth struct {
	mu     sync.Mutex
	values []bool
}

func (h *recordingHealth) MarkMonitor(healthy bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.values = append(h.values, healthy)
}

func (h *recordingHealth) sawUnhealthy() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, value := range h.values {
		if !value {
			return true
		}
	}
	return false
}

type fakeSource struct {
	inspections []deployment.Inspection
}

type blockingSource struct {
	started chan struct{}
	once    sync.Once
}

func (*blockingSource) List(context.Context) ([]deployment.Inspection, error) { return nil, nil }

func (s *blockingSource) Watch(
	ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	if err := ready(ctx); err != nil {
		return err
	}
	s.once.Do(func() { close(s.started) })
	<-ctx.Done()
	return ctx.Err()
}

func (s *fakeSource) List(context.Context) ([]deployment.Inspection, error) {
	return s.inspections, nil
}
func (*fakeSource) Watch(
	ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	if err := ready(ctx); err != nil {
		return err
	}
	return context.Canceled
}

type fakeSink struct {
	values                  []deployment.Observation
	inspectErr              error
	validateErr             error
	storageErr              error
	expectedErr             error
	storageReconciliations  int
	expectedReconciliations int
}

func (s *fakeSink) ReconcileRetainedStorage(context.Context) error {
	s.storageReconciliations++
	return s.storageErr
}

func (s *fakeSink) ReconcileExpectedRuntimes(
	_ context.Context, _ []deployment.Inspection,
) error {
	s.expectedReconciliations++
	return s.expectedErr
}

func (s *fakeSink) ValidateRuntimeInspection(context.Context, deployment.Inspection) error {
	return s.validateErr
}

func (s *fakeSink) InspectPlatformRuntime(_ context.Context, key deployment.Key) (deployment.Inspection, error) {
	if s.inspectErr != nil {
		return deployment.Inspection{}, s.inspectErr
	}
	return deployment.Inspection{
		AgentID: key.AgentID, Generation: key.Generation,
		SpecDigest:         testSpecDigest,
		PlatformResourceID: "container-1", RuntimeExecutionID: "execution-1",
		PlatformPhase: deployment.PhaseRunning, Health: deployment.HealthHealthy,
		ObservedAt: time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC),
	}, nil
}

type fakeCoordinator struct{ monitorReady bool }

func (*fakeCoordinator) TryAcquireObservationLeadership(
	context.Context,
) (repository.Leadership, bool, error) {
	return nil, false, nil
}

func (c *fakeCoordinator) ObservationMonitorReady(context.Context) (bool, error) {
	return c.monitorReady, nil
}

type fakeLeadership struct {
	done     chan struct{}
	once     sync.Once
	err      error
	releases atomic.Int32
}

func newFakeLeadership() *fakeLeadership { return &fakeLeadership{done: make(chan struct{})} }

func (l *fakeLeadership) Done() <-chan struct{} { return l.done }
func (l *fakeLeadership) Err() error            { return l.err }
func (l *fakeLeadership) Release(context.Context) error {
	l.releases.Add(1)
	return nil
}
func (l *fakeLeadership) MarkObservationReady(context.Context) error   { return nil }
func (l *fakeLeadership) MarkObservationUnready(context.Context) error { return nil }
func (l *fakeLeadership) lose(err error) {
	l.err = err
	l.once.Do(func() { close(l.done) })
}

type sequenceCoordinator struct {
	lease *fakeLeadership
	calls atomic.Int32
}

func (c *sequenceCoordinator) TryAcquireObservationLeadership(
	context.Context,
) (repository.Leadership, bool, error) {
	if c.calls.Add(1) == 1 {
		return c.lease, true, nil
	}
	return nil, false, nil
}
func (c *sequenceCoordinator) ObservationMonitorReady(context.Context) (bool, error) {
	return c.calls.Load() > 1, nil
}
func (s *fakeSink) RecordPlatformObservation(
	_ context.Context, value deployment.Observation,
) (deployment.Observation, error) {
	s.values = append(s.values, value)
	return value, nil
}
