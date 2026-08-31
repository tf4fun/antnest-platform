package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	platformmonitor "soft/antnest-platform/services/runtime-controller/internal/platform/monitor"
)

func TestPlatformWatchDoesNotCreateLongLivedSpan(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := platformTracer
	platformTracer = provider.Tracer(instrumentationName + "/platform")
	t.Cleanup(func() {
		platformTracer = original
		_ = provider.Shutdown(context.Background())
	})
	observed, err := ObservePlatform(&sessionPlatform{}, slog.New(slog.NewTextHandler(io.Discard, nil)), "docker")
	if err != nil {
		t.Fatal(err)
	}
	if err := observed.Watch(context.Background(), time.Time{}, func(context.Context, deployment.Observation) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("platform Watch created session-long spans: %d", len(spans))
	}
}

func TestObservationListenerDoesNotCreateLongLivedSpan(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := repositoryTracer
	repositoryTracer = provider.Tracer(instrumentationName + "/repository")
	t.Cleanup(func() {
		repositoryTracer = original
		_ = provider.Shutdown(context.Background())
	})
	observed, err := ObserveRepository(&sessionRepository{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err := observed.ListenObservationNotifications(context.Background(), func() {}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("observation listener created session-long spans: %d", len(spans))
	}
}

func TestObservationWatchDoesNotCreateConnectionLifetimeSpan(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := httpTracer
	httpTracer = provider.Tracer(instrumentationName)
	t.Cleanup(func() {
		httpTracer = original
		_ = provider.Shutdown(context.Background())
	})
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	handler := HTTPHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-release
	}))
	go func() {
		defer close(done)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(
			http.MethodGet, "/internal/runtime-observations/watch", nil,
		))
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("observation Watch handler did not start")
	}
	if spans := recorder.Started(); len(spans) != 0 {
		t.Fatalf("observation Watch created a connection-lifetime span: %d", len(spans))
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("observation Watch handler did not stop")
	}
}

type sessionPlatform struct{}

func (*sessionPlatform) Ready(context.Context) error                            { return nil }
func (*sessionPlatform) DeploymentDigest(deployment.Deployment) (string, error) { return "", nil }
func (*sessionPlatform) Create(context.Context, deployment.Deployment, string) deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (*sessionPlatform) Inspect(context.Context, deployment.Key) (deployment.Inspection, error) {
	return deployment.Inspection{}, nil
}
func (*sessionPlatform) Delete(context.Context, deployment.Key, string) deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (*sessionPlatform) EnsureStorage(context.Context, string) deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (*sessionPlatform) VerifyStorage(context.Context, string) deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (*sessionPlatform) DeleteStorage(context.Context, string) deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}
func (*sessionPlatform) List(context.Context) ([]deployment.Inspection, error) { return nil, nil }
func (*sessionPlatform) Watch(context.Context, time.Time, func(context.Context, deployment.Observation) error) error {
	return nil
}

type sessionRepository struct{}

func (*sessionRepository) BeginTransition(context.Context, deployment.Operation) (deployment.Operation, bool, error) {
	return deployment.Operation{}, false, nil
}
func (*sessionRepository) GenerationClaim(context.Context, deployment.Key) (control.GenerationClaim, error) {
	return control.GenerationClaim{}, nil
}
func (*sessionRepository) CompleteOperation(context.Context, deployment.Operation, *deployment.Observation) (*deployment.Observation, error) {
	return nil, nil
}
func (*sessionRepository) GetOperation(context.Context, string) (deployment.Operation, error) {
	return deployment.Operation{}, nil
}
func (*sessionRepository) GetEnvironment(context.Context, string) (deployment.Environment, error) {
	return deployment.Environment{}, nil
}
func (*sessionRepository) ListEnvironments(context.Context) ([]deployment.Environment, error) {
	return nil, nil
}
func (*sessionRepository) AppendObservation(_ context.Context, value deployment.Observation) (deployment.Observation, error) {
	return value, nil
}
func (*sessionRepository) ListObservations(context.Context, uint64, int) ([]deployment.Observation, error) {
	return nil, nil
}
func (*sessionRepository) Ready(context.Context) error { return nil }
func (*sessionRepository) WithAgentLock(_ context.Context, _ string, execute func(context.Context) error) error {
	return execute(context.Background())
}
func (*sessionRepository) TryAcquireObservationLeadership(context.Context) (platformmonitor.Leadership, bool, error) {
	return nil, false, nil
}
func (*sessionRepository) ListenObservationNotifications(_ context.Context, ready func(), notify func(string)) error {
	ready()
	notify("")
	return nil
}
