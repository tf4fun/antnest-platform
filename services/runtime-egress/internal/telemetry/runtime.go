package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otellogglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	instrumentationName = "soft/antnest-platform/runtime-egress"
	defaultServiceName  = "runtime-egress"
	shutdownTimeout     = 5 * time.Second
)

type Config struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
}

func defaultPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	)
}

type Runtime struct {
	logger         *slog.Logger
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
	loggerProvider *sdklog.LoggerProvider
}

func Setup(ctx context.Context, base slog.Handler, cfg Config) (*Runtime, error) {
	if base == nil {
		return nil, fmt.Errorf("base log handler is required")
	}
	local := correlatedHandler{next: base}
	runtime := &Runtime{logger: slog.New(local)}
	if sdkDisabled() {
		return runtime, nil
	}

	signals, err := configuredSignals()
	if err != nil {
		return nil, err
	}
	if !signals.any() {
		return runtime, nil
	}
	res, err := newResource(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create OpenTelemetry resource: %w", err)
	}

	if signals.traces {
		exporter, exportErr := otlptracehttp.New(ctx)
		if exportErr != nil {
			return nil, fmt.Errorf("create OTLP trace exporter: %w", exportErr)
		}
		runtime.tracerProvider = sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter),
			sdktrace.WithResource(res),
		)
		otel.SetTracerProvider(runtime.tracerProvider)
	}
	if signals.metrics {
		exporter, exportErr := otlpmetrichttp.New(ctx)
		if exportErr != nil {
			cleanupErr := runtime.shutdown(context.Background())
			return nil, errors.Join(fmt.Errorf("create OTLP metric exporter: %w", exportErr), cleanupErr)
		}
		runtime.meterProvider = sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)),
			sdkmetric.WithResource(res),
		)
		otel.SetMeterProvider(runtime.meterProvider)
	}
	if signals.logs {
		exporter, exportErr := otlploghttp.New(ctx)
		if exportErr != nil {
			cleanupErr := runtime.shutdown(context.Background())
			return nil, errors.Join(fmt.Errorf("create OTLP log exporter: %w", exportErr), cleanupErr)
		}
		runtime.loggerProvider = sdklog.NewLoggerProvider(
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
			sdklog.WithResource(res),
		)
		otellogglobal.SetLoggerProvider(runtime.loggerProvider)
		otelHandler := otelslog.NewHandler(
			instrumentationName,
			otelslog.WithLoggerProvider(runtime.loggerProvider),
			otelslog.WithVersion(cfg.ServiceVersion),
		)
		runtime.logger = slog.New(fanoutHandler{handlers: []slog.Handler{local, otelHandler}})
	}

	otel.SetTextMapPropagator(defaultPropagator())
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		slog.New(local).Error("OpenTelemetry export failed", "error", err)
	}))
	return runtime, nil
}

func (r *Runtime) Logger() *slog.Logger {
	if r == nil || r.logger == nil {
		return slog.Default()
	}
	return r.logger
}

func (r *Runtime) Enabled() bool {
	return r != nil && (r.tracerProvider != nil || r.meterProvider != nil || r.loggerProvider != nil)
}

func (r *Runtime) Shutdown(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, shutdownTimeout)
		defer cancel()
	}
	return r.shutdown(ctx)
}

func (r *Runtime) shutdown(ctx context.Context) error {
	var result error
	if r.loggerProvider != nil {
		result = errors.Join(result, r.loggerProvider.Shutdown(ctx))
		r.loggerProvider = nil
	}
	if r.meterProvider != nil {
		result = errors.Join(result, r.meterProvider.Shutdown(ctx))
		r.meterProvider = nil
	}
	if r.tracerProvider != nil {
		result = errors.Join(result, r.tracerProvider.Shutdown(ctx))
		r.tracerProvider = nil
	}
	return result
}

type signalSet struct {
	traces  bool
	metrics bool
	logs    bool
}

func (s signalSet) any() bool { return s.traces || s.metrics || s.logs }

func configuredSignals() (signalSet, error) {
	traces, err := signalEnabled("traces")
	if err != nil {
		return signalSet{}, err
	}
	metrics, err := signalEnabled("metrics")
	if err != nil {
		return signalSet{}, err
	}
	logs, err := signalEnabled("logs")
	if err != nil {
		return signalSet{}, err
	}
	return signalSet{traces: traces, metrics: metrics, logs: logs}, nil
}

func signalEnabled(signal string) (bool, error) {
	exporterKey := "OTEL_" + strings.ToUpper(signal) + "_EXPORTER"
	if raw, exists := os.LookupEnv(exporterKey); exists && strings.TrimSpace(raw) != "" {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "none":
			return false, nil
		case "otlp":
			return validateHTTPProtocol(signal)
		default:
			return false, fmt.Errorf("%s supports only otlp or none", exporterKey)
		}
	}
	signalEndpoint := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_ENDPOINT"
	if strings.TrimSpace(os.Getenv(signalEndpoint)) == "" &&
		strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) == "" {
		return false, nil
	}
	return validateHTTPProtocol(signal)
}

func validateHTTPProtocol(signal string) (bool, error) {
	key := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_PROTOCOL"
	protocol := strings.TrimSpace(os.Getenv(key))
	if protocol == "" {
		protocol = strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"))
		key = "OTEL_EXPORTER_OTLP_PROTOCOL"
	}
	switch strings.ToLower(protocol) {
	case "", "http/protobuf":
		return true, nil
	default:
		return false, fmt.Errorf("%s supports only http/protobuf in this Antnest build", key)
	}
}

func sdkDisabled() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true")
}

func newResource(ctx context.Context, cfg Config) (*resource.Resource, error) {
	serviceName := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME"))
	if serviceName == "" {
		serviceName = strings.TrimSpace(cfg.ServiceName)
	}
	if serviceName == "" {
		serviceName = defaultServiceName
	}
	attrs := []attribute.KeyValue{
		attribute.String("service.name", serviceName),
		attribute.String("service.namespace", defaultServiceName),
	}
	if version := strings.TrimSpace(cfg.ServiceVersion); version != "" {
		attrs = append(attrs, attribute.String("service.version", version))
	}
	if environment := strings.TrimSpace(cfg.Environment); environment != "" {
		attrs = append(attrs, attribute.String("deployment.environment.name", environment))
	}
	return resource.New(
		ctx,
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithOS(),
		resource.WithProcess(),
		resource.WithContainer(),
		resource.WithAttributes(attrs...),
	)
}

type correlatedHandler struct {
	next slog.Handler
}

func (h correlatedHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h correlatedHandler) Handle(ctx context.Context, record slog.Record) error {
	spanContext := trace.SpanContextFromContext(ctx)
	if spanContext.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", spanContext.TraceID().String()),
			slog.String("span_id", spanContext.SpanID().String()),
		)
	}
	return h.next.Handle(ctx, record)
}

func (h correlatedHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return correlatedHandler{next: h.next.WithAttrs(attrs)}
}

func (h correlatedHandler) WithGroup(name string) slog.Handler {
	return correlatedHandler{next: h.next.WithGroup(name)}
}

type fanoutHandler struct {
	handlers []slog.Handler
}

func (h fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (h fanoutHandler) Handle(ctx context.Context, record slog.Record) error {
	var result error
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, record.Level) {
			result = errors.Join(result, handler.Handle(ctx, record.Clone()))
		}
	}
	return result
}

func (h fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		handlers = append(handlers, handler.WithAttrs(attrs))
	}
	return fanoutHandler{handlers: handlers}
}

func (h fanoutHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		handlers = append(handlers, handler.WithGroup(name))
	}
	return fanoutHandler{handlers: handlers}
}
