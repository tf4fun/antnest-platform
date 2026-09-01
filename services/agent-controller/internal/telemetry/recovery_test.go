package telemetry

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestObserveLifecycleRecoveryAttemptStartsNewTraceWithCausalLinks(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	instrument, err := ObserveLifecycleRecoveryAttempt(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("observe recovery attempt: %v", err)
	}
	callerCtx, caller := otel.Tracer("recovery-test").Start(context.Background(), "caller")
	initial := "00-11111111111111111111111111111111-1111111111111111-01"
	previous := "00-22222222222222222222222222222222-2222222222222222-01"
	var attemptContext trace.SpanContext
	var persistedTraceParent string
	result, err := instrument(callerCtx, ports.LifecycleRecoveryClaim{
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-1", AgentID: "agent-1", Kind: domain.OperationRebuild,
			Phase: domain.PhaseRuntimeUpdate, State: domain.OperationRunning,
			InitialTraceParent: initial, PreviousRecoveryTraceParent: previous,
		},
		WorkerID: "worker-1", Attempt: 3,
	}, func(ctx context.Context, traceParent string) (application.LifecycleRecoveryResult, error) {
		attemptContext = trace.SpanContextFromContext(ctx)
		persistedTraceParent = traceParent
		_, dependency := otel.Tracer("recovery-test").Start(ctx, "dependency")
		dependency.End()
		return application.LifecycleRecoveryResult{
			Phase: domain.PhaseNetworkRestore, State: domain.OperationRunning, Progressed: true,
		}, nil
	})
	caller.End()
	if err != nil {
		t.Fatalf("instrument recovery attempt: %v", err)
	}
	if !result.Progressed || !attemptContext.IsValid() {
		t.Fatalf("result=%+v span=%+v", result, attemptContext)
	}
	if persistedTraceParent != formatTraceParent(attemptContext) {
		t.Fatalf("persisted traceparent = %q", persistedTraceParent)
	}

	var recovery sdktrace.ReadOnlySpan
	var dependency sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		switch span.Name() {
		case "recover Agent lifecycle operation":
			recovery = span
		case "dependency":
			dependency = span
		}
	}
	if recovery == nil || dependency == nil {
		t.Fatalf("ended spans = %+v", recorder.Ended())
	}
	if recovery.Parent().IsValid() {
		t.Fatalf("recovery unexpectedly inherited parent %s", recovery.Parent().SpanID())
	}
	if recovery.SpanContext().TraceID() == trace.SpanContextFromContext(callerCtx).TraceID() {
		t.Fatal("recovery reused caller trace")
	}
	if dependency.Parent().SpanID() != recovery.SpanContext().SpanID() {
		t.Fatalf("dependency parent = %s recovery = %s", dependency.Parent().SpanID(), recovery.SpanContext().SpanID())
	}
	workerID := ""
	for _, attr := range recovery.Attributes() {
		if string(attr.Key) == "antnest.lifecycle.recovery.worker_id" {
			workerID = attr.Value.AsString()
		}
	}
	if workerID != "worker-1" {
		t.Fatalf("recovery worker attribute = %q", workerID)
	}
	linked := map[string]bool{}
	for _, link := range recovery.Links() {
		linked[link.SpanContext.TraceID().String()] = true
	}
	if len(recovery.Links()) != 2 || !linked["11111111111111111111111111111111"] ||
		!linked["22222222222222222222222222222222"] {
		t.Fatalf("recovery links = %+v", recovery.Links())
	}
}

func TestObserveLifecycleRecoveryAttemptRejectsNilLogger(t *testing.T) {
	t.Parallel()

	if _, err := ObserveLifecycleRecoveryAttempt(nil); err == nil {
		t.Fatal("nil logger was accepted")
	}
}

func TestObservedLifecycleRecoveryStoreDoesNotTraceEmptyPoll(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
	})

	observed, err := ObserveLifecycleRecoveryStore(
		&emptyLifecycleRecoveryStore{}, slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatalf("observe lifecycle recovery store: %v", err)
	}
	_, found, err := observed.ClaimLifecycleRecovery(context.Background(), ports.ClaimLifecycleRecovery{
		WorkerID: "worker-1", StaleAfter: time.Minute, LeaseDuration: time.Minute,
	})
	if err != nil || found {
		t.Fatalf("empty recovery poll found=%v err=%v", found, err)
	}
	if ended := recorder.Ended(); len(ended) != 0 {
		t.Fatalf("empty recovery poll emitted spans: %#v", ended)
	}
}

type emptyLifecycleRecoveryStore struct{}

func (*emptyLifecycleRecoveryStore) ClaimLifecycleRecovery(
	context.Context, ports.ClaimLifecycleRecovery,
) (ports.LifecycleRecoveryClaim, bool, error) {
	return ports.LifecycleRecoveryClaim{}, false, nil
}

func (*emptyLifecycleRecoveryStore) StartLifecycleRecoveryAttempt(
	context.Context, ports.StartLifecycleRecoveryAttempt,
) error {
	return nil
}

func (*emptyLifecycleRecoveryStore) ReleaseLifecycleRecoveryClaim(
	context.Context, ports.ReleaseLifecycleRecoveryClaim,
) error {
	return nil
}
