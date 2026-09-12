package telemetry

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestSetupDefaultsToLocalStructuredLogging(t *testing.T) {
	clearEnvironment(t)
	var output bytes.Buffer
	runtime, err := Setup(context.Background(), slog.NewJSONHandler(&output, nil), Config{
		ServiceName: "runtime-controller",
	})
	if err != nil {
		t.Fatalf("setup telemetry: %v", err)
	}
	if runtime.Enabled() {
		t.Fatal("telemetry enabled without an OTLP endpoint")
	}
	runtime.Logger().Info("local event")
	if !strings.Contains(output.String(), "local event") {
		t.Fatalf("local log missing: %s", output.String())
	}
}

func TestSetupRejectsUnsupportedOTLPProtocol(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
	_, err := Setup(context.Background(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{})
	if err == nil {
		t.Fatal("unsupported OTLP protocol was accepted")
	}
}

func TestDisabledSDKStillPropagatesW3CTraceContext(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("OTEL_SDK_DISABLED", "true")
	_, err := Setup(context.Background(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	carrier := propagation.MapCarrier{
		"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"baggage":     "secret=BAGGAGE_CANARY",
	}
	ctx := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	if !trace.SpanContextFromContext(ctx).IsValid() {
		t.Fatal("trace context propagation was disabled with OTLP export")
	}
	outgoing := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, outgoing)
	if outgoing.Get("traceparent") != carrier.Get("traceparent") || outgoing.Get("baggage") != "" {
		t.Fatal("disabled propagation or baggage isolation changed")
	}
}

func TestSetupRejectsInvalidDiagnosticModeWithoutExporter(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "unsafe")
	if _, err := Setup(context.Background(), slog.NewTextHandler(&bytes.Buffer{}, nil), Config{}); err == nil {
		t.Fatal("invalid diagnostic mode accepted")
	}
}

func clearEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT",
		"OTEL_SDK_DISABLED", "OTEL_SERVICE_NAME", "OTEL_RESOURCE_ATTRIBUTES",
		"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_TRACES_EXPORTER",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_METRICS_EXPORTER",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_LOGS_EXPORTER",
	} {
		t.Setenv(key, "")
	}
}
