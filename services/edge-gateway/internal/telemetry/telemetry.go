package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationName = "github.com/tf4fun/antnest-platform/edge-gateway"

type Config struct {
	ServiceVersion string
	Environment    string
}

type Runtime struct {
	logger        *slog.Logger
	shutdownMu    sync.Mutex
	provider      *sdktrace.TracerProvider
	traceExporter *ownedTraceExporter
	meterProvider *sdkmetric.MeterProvider
}

func Setup(ctx context.Context, base slog.Handler, config Config) (*Runtime, error) {
	if base == nil {
		return nil, fmt.Errorf("base log handler is required")
	}
	correlated := correlatedHandler{next: base}
	runtime := &Runtime{logger: slog.New(correlated)}
	otel.SetTextMapPropagator(propagation.TraceContext{})
	metrics, err := metricsEnabled()
	if err != nil {
		return nil, err
	}
	traces := tracesEnabled()
	if !metrics {
		otel.SetMeterProvider(noop.NewMeterProvider())
	}
	if !traces && !metrics {
		return runtime, nil
	}
	serviceName := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME"))
	if serviceName == "" {
		serviceName = "edge-gateway"
	}
	attributes := []attribute.KeyValue{
		attribute.String("service.name", serviceName),
		attribute.String("service.namespace", "antnest"),
	}
	if config.ServiceVersion != "" {
		attributes = append(attributes, attribute.String("service.version", config.ServiceVersion))
	}
	if config.Environment != "" {
		attributes = append(attributes, attribute.String("deployment.environment.name", config.Environment))
	}
	res, err := resource.New(ctx, resource.WithFromEnv(), resource.WithTelemetrySDK(),
		resource.WithContainer(), resource.WithAttributes(attributes...))
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	if traces {
		exporter, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
		}
		runtime.traceExporter = newOwnedTraceExporter(exporter)
		runtime.provider = sdktrace.NewTracerProvider(sdktrace.WithBatcher(runtime.traceExporter), sdktrace.WithResource(res))
		otel.SetTracerProvider(runtime.provider)
	}
	if metrics {
		exporter, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("create OTLP metric exporter: %w", err), runtime.Shutdown(context.Background()))
		}
		runtime.meterProvider = sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)), sdkmetric.WithResource(res),
		)
		otel.SetMeterProvider(runtime.meterProvider)
	}
	return runtime, nil
}

func (runtime *Runtime) Logger() *slog.Logger {
	if runtime == nil || runtime.logger == nil {
		return slog.Default()
	}
	return runtime.logger
}

func (runtime *Runtime) Shutdown(ctx context.Context) error {
	if runtime == nil {
		return nil
	}
	runtime.shutdownMu.Lock()
	defer runtime.shutdownMu.Unlock()
	var result error
	// Cleanup must run even for an already-cancelled caller. Otherwise the
	// trace SDK marks itself shut down before ever stopping its batch worker.
	// Preserve caller failure in the result, with independent cleanup budgets.
	parent := context.WithoutCancel(ctx)
	if runtime.meterProvider != nil {
		bounded, cancel := context.WithTimeout(parent, 5*time.Second)
		result = errors.Join(result, runtime.meterProvider.Shutdown(bounded))
		cancel()
		runtime.meterProvider = nil
	}
	if runtime.provider != nil {
		if runtime.traceExporter != nil {
			// BSP uses background contexts for active/queued exports. At drain
			// expiry, cancel their owned scope, then let BSP finish joining its
			// worker instead of returning early on an expired SDK shutdown ctx.
			// Exporter resource shutdown has a separate five-second budget.
			finish := runtime.traceExporter.beginDrain(parent)
			result = errors.Join(result, runtime.provider.Shutdown(parent))
			_ = finish() // Also release timer state if the SDK was already closed.
			runtime.traceExporter.cancel()
			runtime.traceExporter = nil
		} else {
			bounded, cancel := context.WithTimeout(parent, 5*time.Second)
			result = errors.Join(result, runtime.provider.Shutdown(bounded))
			cancel()
		}
		runtime.provider = nil
	}
	return errors.Join(result, ctx.Err())
}

// Metrics are opt-in: a trace-only Jaeger endpoint is not a metrics receiver.
func metricsEnabled() (bool, error) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return false, nil
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OTEL_METRICS_EXPORTER"))) {
	case "", "none":
		return false, nil
	case "otlp":
		protocol := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"))
		if protocol == "" {
			protocol = strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"))
		}
		if protocol != "" && !strings.EqualFold(protocol, "http/protobuf") {
			return false, fmt.Errorf("gateway OTLP metrics supports only http/protobuf")
		}
		return true, nil
	default:
		return false, fmt.Errorf("OTEL_METRICS_EXPORTER supports only otlp or none")
	}
}

func tracesEnabled() bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OTEL_TRACES_EXPORTER"))) {
	case "none":
		return false
	case "otlp":
		return true
	case "":
		return strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) != "" ||
			strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) != ""
	default:
		return false
	}
}

type correlatedHandler struct{ next slog.Handler }

func (handler correlatedHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return handler.next.Enabled(ctx, level)
}

func (handler correlatedHandler) Handle(ctx context.Context, record slog.Record) error {
	spanContext := trace.SpanContextFromContext(ctx)
	if spanContext.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", spanContext.TraceID().String()),
			slog.String("span_id", spanContext.SpanID().String()),
		)
	}
	return handler.next.Handle(ctx, record)
}

func (handler correlatedHandler) WithAttrs(attributes []slog.Attr) slog.Handler {
	return correlatedHandler{next: handler.next.WithAttrs(attributes)}
}

func (handler correlatedHandler) WithGroup(name string) slog.Handler {
	return correlatedHandler{next: handler.next.WithGroup(name)}
}
