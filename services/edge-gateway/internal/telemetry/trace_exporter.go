package telemetry

import (
	"context"
	"errors"
	"sync"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// The SDK batch worker exports with its own background context. Owning this
// additional cancellation scope lets shutdown interrupt its active upload and
// reject queued uploads before joining the real worker.
type ownedTraceExporter struct {
	delegate    sdktrace.SpanExporter
	ctx         context.Context
	cancel      context.CancelFunc
	finishDrain func() error
}

func newOwnedTraceExporter(delegate sdktrace.SpanExporter) *ownedTraceExporter {
	ctx, cancel := context.WithCancel(context.Background())
	return &ownedTraceExporter{delegate: delegate, ctx: ctx, cancel: cancel}
}

func (exporter *ownedTraceExporter) beginDrain(parent context.Context) func() error {
	drain, cancel := context.WithTimeout(parent, 5*time.Second)
	stop := context.AfterFunc(drain, exporter.cancel)
	var once sync.Once
	var result error
	finish := func() error {
		once.Do(func() {
			stop()
			result = drain.Err()
			cancel()
		})
		return result
	}
	exporter.finishDrain = finish
	return finish
}

func (exporter *ownedTraceExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if err := exporter.ctx.Err(); err != nil {
		return err
	}
	owned, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(exporter.ctx, cancel)
	defer stop()
	defer cancel()
	return exporter.delegate.ExportSpans(owned, spans)
}

func (exporter *ownedTraceExporter) Shutdown(ctx context.Context) error {
	// BSP calls exporter shutdown only after joining its batch worker. End
	// the drain budget here; successful cleanup must not consume that budget.
	var drainErr error
	if exporter.finishDrain != nil {
		drainErr = exporter.finishDrain()
	}
	exporter.cancel()
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return errors.Join(drainErr, exporter.delegate.Shutdown(cleanup), cleanup.Err())
}
