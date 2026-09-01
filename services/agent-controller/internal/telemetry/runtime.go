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
	instrumentationName = "soft/antnest-platform/agent-controller"
	defaultServiceName  = "agent-controller"
)

type Config struct {
	ServiceVersion string
	Environment    string
}

type Runtime struct {
	logger         *slog.Logger
	tracerProvider *sdktrace.TracerProvider
	meterProvider  *sdkmetric.MeterProvider
	loggerProvider *sdklog.LoggerProvider
}

func Setup(ctx context.Context, base slog.Handler, config Config) (*Runtime, error) {
	if base == nil {
		return nil, fmt.Errorf("base log handler is required")
	}
	local := correlatedHandler{next: base}
	localLogger := slog.New(local)
	runtime := &Runtime{logger: localLogger}
	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {
		localLogger.Error("OpenTelemetry export failed", "error_class", "export_error")
	}))
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return runtime, nil
	}
	signals, err := configuredSignals()
	if err != nil {
		return nil, err
	}
	if !signals.traces && !signals.metrics && !signals.logs {
		return runtime, nil
	}
	res, err := newResource(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create OpenTelemetry resource: %w", err)
	}
	if err := runtime.setupSignals(ctx, signals, res, local, config); err != nil {
		return nil, errors.Join(err, runtime.Shutdown(context.Background()))
	}
	return runtime, nil
}

func (runtime *Runtime) setupSignals(
	ctx context.Context,
	signals signalSet,
	res *resource.Resource,
	local slog.Handler,
	config Config,
) error {
	if signals.traces {
		exporter, err := otlptracehttp.New(ctx)
		if err != nil {
			return fmt.Errorf("create OTLP trace exporter: %w", err)
		}
		runtime.tracerProvider = sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter), sdktrace.WithResource(res),
		)
		otel.SetTracerProvider(runtime.tracerProvider)
	}
	if signals.metrics {
		exporter, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return fmt.Errorf("create OTLP metric exporter: %w", err)
		}
		runtime.meterProvider = sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)), sdkmetric.WithResource(res),
		)
		otel.SetMeterProvider(runtime.meterProvider)
	}
	if signals.logs {
		exporter, err := otlploghttp.New(ctx)
		if err != nil {
			return fmt.Errorf("create OTLP log exporter: %w", err)
		}
		runtime.loggerProvider = sdklog.NewLoggerProvider(
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)), sdklog.WithResource(res),
		)
		otellogglobal.SetLoggerProvider(runtime.loggerProvider)
		otelHandler := otelslog.NewHandler(
			instrumentationName,
			otelslog.WithLoggerProvider(runtime.loggerProvider),
			otelslog.WithVersion(config.ServiceVersion),
		)
		runtime.logger = slog.New(fanoutHandler{handlers: []slog.Handler{local, otelHandler}})
	}
	return nil
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
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
	}
	var result error
	if runtime.loggerProvider != nil {
		result = errors.Join(result, runtime.loggerProvider.Shutdown(ctx))
		runtime.loggerProvider = nil
	}
	if runtime.meterProvider != nil {
		result = errors.Join(result, runtime.meterProvider.Shutdown(ctx))
		runtime.meterProvider = nil
	}
	if runtime.tracerProvider != nil {
		result = errors.Join(result, runtime.tracerProvider.Shutdown(ctx))
		runtime.tracerProvider = nil
	}
	return result
}

type signalSet struct{ traces, metrics, logs bool }

func configuredSignals() (signalSet, error) {
	var result signalSet
	for name, target := range map[string]*bool{
		"traces": &result.traces, "metrics": &result.metrics, "logs": &result.logs,
	} {
		enabled, err := signalEnabled(name)
		if err != nil {
			return signalSet{}, err
		}
		*target = enabled
	}
	return result, nil
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
	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_ENDPOINT"))
	if endpoint == "" && strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) == "" {
		return false, nil
	}
	return validateHTTPProtocol(signal)
}

func validateHTTPProtocol(signal string) (bool, error) {
	key := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_PROTOCOL"
	protocol := strings.TrimSpace(os.Getenv(key))
	if protocol == "" {
		key = "OTEL_EXPORTER_OTLP_PROTOCOL"
		protocol = strings.TrimSpace(os.Getenv(key))
	}
	if protocol == "" || strings.EqualFold(protocol, "http/protobuf") {
		return true, nil
	}
	return false, fmt.Errorf("%s supports only http/protobuf", key)
}

func newResource(ctx context.Context, config Config) (*resource.Resource, error) {
	serviceName := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME"))
	if serviceName == "" {
		serviceName = defaultServiceName
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
	return resource.New(
		ctx, resource.WithFromEnv(), resource.WithTelemetrySDK(), resource.WithHost(),
		resource.WithOS(), resource.WithProcess(), resource.WithContainer(), resource.WithAttributes(attributes...),
	)
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

type fanoutHandler struct{ handlers []slog.Handler }

func (handler fanoutHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, child := range handler.handlers {
		if child.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (handler fanoutHandler) Handle(ctx context.Context, record slog.Record) error {
	var result error
	for _, child := range handler.handlers {
		if child.Enabled(ctx, record.Level) {
			result = errors.Join(result, child.Handle(ctx, record.Clone()))
		}
	}
	return result
}

func (handler fanoutHandler) WithAttrs(attributes []slog.Attr) slog.Handler {
	result := make([]slog.Handler, 0, len(handler.handlers))
	for _, child := range handler.handlers {
		result = append(result, child.WithAttrs(attributes))
	}
	return fanoutHandler{handlers: result}
}

func (handler fanoutHandler) WithGroup(name string) slog.Handler {
	result := make([]slog.Handler, 0, len(handler.handlers))
	for _, child := range handler.handlers {
		result = append(result, child.WithGroup(name))
	}
	return fanoutHandler{handlers: result}
}
