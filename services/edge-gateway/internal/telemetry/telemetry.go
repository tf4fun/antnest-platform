package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationName = "soft/antnest-platform/edge-gateway"

type Config struct {
	ServiceVersion string
	Environment    string
}

type Runtime struct {
	logger   *slog.Logger
	provider *sdktrace.TracerProvider
}

func Setup(ctx context.Context, base slog.Handler, config Config) (*Runtime, error) {
	if base == nil {
		return nil, fmt.Errorf("base log handler is required")
	}
	correlated := correlatedHandler{next: base}
	runtime := &Runtime{logger: slog.New(correlated)}
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	if !tracesEnabled() {
		return runtime, nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
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
	runtime.provider = sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter), sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(runtime.provider)
	return runtime, nil
}

func (runtime *Runtime) Logger() *slog.Logger {
	if runtime == nil || runtime.logger == nil {
		return slog.Default()
	}
	return runtime.logger
}

func (runtime *Runtime) Shutdown(ctx context.Context) error {
	if runtime == nil || runtime.provider == nil {
		return nil
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
	}
	err := runtime.provider.Shutdown(ctx)
	runtime.provider = nil
	return err
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
