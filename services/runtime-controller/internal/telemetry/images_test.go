package telemetry

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

func TestImageResolutionPreservesTraceAndUsesBoundedAttributes(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	original := platformTracer
	platformTracer = provider.Tracer(instrumentationName + "/platform")
	t.Cleanup(func() {
		platformTracer = original
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	want := platform.ImageResolution{Reference: "private.example/runtime:local", ImageRef: "immutable-image"}
	for _, cause := range []error{nil, platform.ErrImageNotFound} {
		ctx, parent := provider.Tracer("caller").Start(context.Background(), "catalog.resolve_image")
		observed, err := ObservePlatform(imagePlatform{resolve: func(got context.Context, reference string) (platform.ImageResolution, error) {
			child := trace.SpanContextFromContext(got)
			if child.TraceID() != parent.SpanContext().TraceID() || child.SpanID() == parent.SpanContext().SpanID() {
				t.Fatal("image adapter did not receive a child span")
			}
			if reference != want.Reference {
				t.Fatalf("reference = %q", reference)
			}
			return want, cause
		}}, slog.New(slog.NewTextHandler(io.Discard, nil)), "docker")
		if err != nil {
			t.Fatal(err)
		}
		result, err := observed.ResolveImage(ctx, want.Reference)
		parent.End()
		if result != want || !errors.Is(err, cause) {
			t.Fatalf("result = %+v, error = %v", result, err)
		}
		spans := recorder.Ended()
		child := spans[len(spans)-2]
		if child.Name() != "runtime.platform.resolve_image" || child.Parent().SpanID() != parent.SpanContext().SpanID() {
			t.Fatalf("image span = %+v", child)
		}
		if (cause != nil) != (child.Status().Code == codes.Error) {
			t.Fatalf("span status = %+v, error = %v", child.Status(), cause)
		}
		for _, attribute := range child.Attributes() {
			switch attribute.Key {
			case "antnest.platform", "antnest.platform.operation", "antnest.result", "antnest.outcome", "antnest.operation.phase", "antnest.runtime.image.reference", "antnest.runtime.image.id", "error.type", "antnest.error.type", "antnest.error.stage", "antnest.error.code":
			default:
				t.Fatalf("unexpected image or lifecycle attribute: %+v", attribute)
			}
		}
		attrs := spanAttrs(child)
		if attrs["antnest.runtime.image.reference"].AsString() != want.Reference {
			t.Fatal("actual image tag missing")
		}
		if cause == nil && attrs["antnest.runtime.image.id"].AsString() != want.ImageRef {
			t.Fatal("actual image identity missing")
		}
	}
}

type imagePlatform struct {
	platform.Port
	resolve func(context.Context, string) (platform.ImageResolution, error)
}

func (p imagePlatform) ResolveImage(ctx context.Context, reference string) (platform.ImageResolution, error) {
	return p.resolve(ctx, reference)
}
