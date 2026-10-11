package telemetry

import (
	"context"
	"net/url"
	"sync"

	"go.opentelemetry.io/otel/trace"
)

type clientSpanObserverKey struct{}

type clientSpanObserver struct {
	locker  sync.Locker
	observe func(trace.SpanContext)
}

// WithHTTPClientSpanObserver linearizes actual CLIENT creation and publication
// with the owner's cancellation snapshot. observe runs with locker held and
// must only publish the SpanContext; it must not lock again or perform I/O.
func WithHTTPClientSpanObserver(ctx context.Context, locker sync.Locker, observe func(trace.SpanContext)) context.Context {
	if locker == nil || observe == nil {
		return ctx
	}
	return context.WithValue(ctx, clientSpanObserverKey{}, clientSpanObserver{locker: locker, observe: observe})
}

func startObservedClient(ctx context.Context, method string, target *url.URL) (context.Context, trace.Span) {
	observer, ok := ctx.Value(clientSpanObserverKey{}).(clientSpanObserver)
	if !ok {
		return startClient(ctx, method, target)
	}
	observer.locker.Lock()
	defer observer.locker.Unlock()
	ctx, span := startClient(ctx, method, target)
	observer.observe(span.SpanContext())
	return ctx, span
}
