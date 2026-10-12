package telemetry

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

type blockedTraceExporter struct {
	release       chan struct{}
	stopped       chan struct{}
	active        atomic.Int64
	calls         atomic.Int64
	shutdowns     atomic.Int64
	activeAtStop  atomic.Int64
	stopRemaining time.Duration
}

func (exporter *blockedTraceExporter) ExportSpans(ctx context.Context, _ []sdktrace.ReadOnlySpan) error {
	exporter.calls.Add(1)
	exporter.active.Add(1)
	defer exporter.active.Add(-1)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-exporter.release:
		return nil
	}
}

func (exporter *blockedTraceExporter) Shutdown(ctx context.Context) error {
	exporter.activeAtStop.Store(exporter.active.Load())
	deadline, _ := ctx.Deadline()
	exporter.stopRemaining = time.Until(deadline)
	exporter.shutdowns.Add(1)
	close(exporter.stopped)
	return ctx.Err()
}

func TestTraceShutdownCancelsOwnedExportAndJoinsRealBatchWorker(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		delegate := &blockedTraceExporter{release: make(chan struct{}), stopped: make(chan struct{})}
		owned := newOwnedTraceExporter(delegate)
		processor := sdktrace.NewBatchSpanProcessor(owned, sdktrace.WithBatchTimeout(time.Hour), sdktrace.WithMaxExportBatchSize(1))
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(processor))
		runtime := &Runtime{provider: provider, traceExporter: owned}
		defer func() {
			close(delegate.release) // Failed RED still releases the real SDK worker.
			owned.cancel()
			_ = processor.Shutdown(context.Background())
			<-delegate.stopped
		}()
		for range 2 {
			_, span := provider.Tracer("test").Start(context.Background(), "pending request")
			span.End()
		}
		synctest.Wait()
		if delegate.active.Load() != 1 {
			t.Fatal("fixture did not start a real SDK export")
		}
		started := time.Now()
		err := runtime.Shutdown(context.Background())
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) != 5*time.Second {
			t.Fatalf("bounded trace drain did not report its timeout: %v after %v", err, time.Since(started))
		}
		if delegate.shutdowns.Load() != 1 || delegate.active.Load() != 0 || delegate.activeAtStop.Load() != 0 || delegate.calls.Load() != 1 {
			t.Fatal("shutdown returned before joining the batch worker, or uploaded queued spans after drain expiry")
		}
		if delegate.stopRemaining != 5*time.Second {
			t.Fatal("exporter resource cleanup inherited the expired drain budget")
		}
	})
}

type stagedTraceExporter struct{}

func (*stagedTraceExporter) ExportSpans(ctx context.Context, _ []sdktrace.ReadOnlySpan) error {
	select {
	case <-time.After(2 * time.Second):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (*stagedTraceExporter) Shutdown(ctx context.Context) error {
	select {
	case <-time.After(4 * time.Second):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestTraceDrainAndExporterCleanupHaveSeparateSuccessfulBudgets(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		owned := newOwnedTraceExporter(&stagedTraceExporter{})
		provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(owned, sdktrace.WithBatchTimeout(time.Hour)))
		runtime := &Runtime{provider: provider, traceExporter: owned}
		_, span := provider.Tracer("test").Start(context.Background(), "pending request")
		span.End()
		started := time.Now()
		if err := runtime.Shutdown(context.Background()); err != nil {
			t.Fatalf("successful 2s drain and 4s cleanup were confused with one deadline: %v", err)
		}
		if time.Since(started) != 6*time.Second {
			t.Fatal("fixture did not complete both actual SDK shutdown stages")
		}
	})
}
