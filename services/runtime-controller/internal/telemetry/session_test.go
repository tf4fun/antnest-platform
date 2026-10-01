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

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
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
	if err := observed.Watch(context.Background(), time.Time{}, func(context.Context) error {
		return nil
	}, func(context.Context, deployment.Observation) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("platform Watch created session-long spans: %d", len(spans))
	}
}

func TestSessionResultPreservesTerminationCause(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{name: "completed", want: "completed"},
		{name: "canceled", err: context.Canceled, want: "canceled"},
		{name: "disconnected", err: platform.ErrObservationStreamDisconnected, want: "disconnected"},
		{name: "failed", err: io.ErrUnexpectedEOF, want: "error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := sessionResult(test.err); got != test.want {
				t.Fatalf("sessionResult(%v) = %q, want %q", test.err, got, test.want)
			}
		})
	}
}

func TestObservationWatchRetainsServerUntilConnectionEnds(t *testing.T) {
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
	if spans := recorder.Started(); len(spans) != 1 || len(recorder.Ended()) != 0 {
		t.Fatalf("observation Watch must have one unfinished SERVER span: %d", len(spans))
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("observation Watch handler did not stop")
	}
	if spans := recorder.Ended(); len(spans) != 1 {
		t.Fatal("watch SERVER span did not end")
	}
}

type sessionPlatform struct{}

func (*sessionPlatform) ResolveImage(context.Context, string) (platform.ImageResolution, error) {
	return platform.ImageResolution{}, platform.ErrImageNotFound
}

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
func (*sessionPlatform) Watch(
	ctx context.Context, _ time.Time, ready func(context.Context) error,
	_ func(context.Context, deployment.Observation) error,
) error {
	if err := ready(ctx); err != nil {
		return err
	}
	return nil
}
