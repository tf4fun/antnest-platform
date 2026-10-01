package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestTraceConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, disabled, exporter, endpoint, protocol, specificProtocol string
		enabled, invalid                                               bool
	}{
		{name: "unconfigured"},
		{name: "endpoint", endpoint: "http://collector:4318", enabled: true},
		{name: "explicit_export", exporter: "otlp", enabled: true},
		{name: "disabled", disabled: "true", exporter: "otlp"},
		{name: "none", endpoint: "http://collector:4318", exporter: "none"},
		{name: "invalid_exporter", exporter: "stdout", invalid: true},
		{name: "invalid_protocol", exporter: "otlp", protocol: "grpc", invalid: true},
		{name: "specific_protocol", exporter: "otlp", protocol: "grpc", specificProtocol: "http/protobuf", enabled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OTEL_SDK_DISABLED", tc.disabled)
			t.Setenv("OTEL_TRACES_EXPORTER", tc.exporter)
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", tc.endpoint)
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
			t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", tc.protocol)
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", tc.specificProtocol)
			enabled, err := traceExportEnabled()
			if enabled != tc.enabled || (err != nil) != tc.invalid {
				t.Fatalf("configuration: enabled=%v err=%v", enabled, err)
			}
		})
	}
}

func TestDisabledSDKStillCreatesChildTraceContext(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	previous, previousPropagation := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		otel.SetTextMapPropagator(previousPropagation)
	})
	runtime, err := Setup(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Shutdown(context.Background()) })
	carrier := propagation.MapCarrier{"traceparent": "00-11111111111111111111111111111111-2222222222222222-01"}
	ctx := propagation.TraceContext{}.Extract(t.Context(), carrier)
	parent := trace.SpanContextFromContext(ctx)
	ctx, child := otel.Tracer("fixture").Start(ctx, "child")
	defer child.End()
	if child.SpanContext().TraceID() != parent.TraceID() || child.SpanContext().SpanID() == parent.SpanID() || !child.SpanContext().IsValid() {
		t.Fatal("disabled export lost the incoming context or child identity")
	}
	out := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, out)
	if out.Get("traceparent") == "" || out.Get("traceparent") == carrier.Get("traceparent") {
		t.Fatal("propagator did not inject the child context")
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Shutdown(context.Background()); err != nil {
		t.Fatal("shutdown is not idempotent")
	}
}
