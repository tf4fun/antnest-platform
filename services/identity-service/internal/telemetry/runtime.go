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
	instrumentationName = "github.com/tf4fun/antnest-platform/identity-service"
	defaultServiceName  = "identity-service"
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
	runtime := &Runtime{logger: slog.New(local)}
	capture := strings.ToLower(strings.TrimSpace(os.Getenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT")))
	if capture != "" && capture != "false" && capture != "true" {
		return nil, fmt.Errorf("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT must be true or false")
	}
	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {
		runtime.Logger().Error("OpenTelemetry export failed", "error_class", "export_error")
	}))
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		runtime.installPropagationOnlyProvider()
		return runtime, nil
	}
	signals, err := configuredSignals()
	if err != nil {
		return nil, err
	}
	if !signals.traces && !signals.metrics && !signals.logs {
		runtime.installPropagationOnlyProvider()
		return runtime, nil
	}
	res, err := newResource(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create OpenTelemetry resource: %w", err)
	}
	if signals.traces {
		exporter, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
		}
		runtime.tracerProvider = sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter), sdktrace.WithResource(res),
		)
		otel.SetTracerProvider(runtime.tracerProvider)
	} else {
		runtime.installPropagationOnlyProvider()
	}
	if signals.metrics {
		exporter, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("create OTLP metric exporter: %w", err), runtime.Shutdown(context.Background()))
		}
		runtime.meterProvider = sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)), sdkmetric.WithResource(res),
		)
		otel.SetMeterProvider(runtime.meterProvider)
	}
	if signals.logs {
		exporter, err := otlploghttp.New(ctx)
		if err != nil {
			return nil, errors.Join(fmt.Errorf("create OTLP log exporter: %w", err), runtime.Shutdown(context.Background()))
		}
		runtime.loggerProvider = sdklog.NewLoggerProvider(
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)), sdklog.WithResource(res),
		)
		otellogglobal.SetLoggerProvider(runtime.loggerProvider)
		otelHandler := otelslog.NewHandler(instrumentationName,
			otelslog.WithLoggerProvider(runtime.loggerProvider), otelslog.WithVersion(config.ServiceVersion))
		runtime.logger = slog.New(fanoutHandler{handlers: []slog.Handler{local, otelHandler}})
	}
	return runtime, nil
}

func (r *Runtime) installPropagationOnlyProvider() {
	r.tracerProvider = sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.NeverSample())))
	otel.SetTracerProvider(r.tracerProvider)
}

func (r *Runtime) Logger() *slog.Logger {
	if r == nil || r.logger == nil {
		return slog.Default()
	}
	return r.logger
}

func (r *Runtime) Shutdown(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
	}
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
		attribute.String("service.instance.id", fmt.Sprintf("identity-%d-%d", os.Getpid(), time.Now().UnixNano())),
	}
	if config.ServiceVersion != "" {
		attributes = append(attributes, attribute.String("service.version", config.ServiceVersion))
	}
	if config.Environment != "" {
		attributes = append(attributes, attribute.String("deployment.environment.name", config.Environment))
	}
	return resource.New(ctx, resource.WithFromEnv(), resource.WithTelemetrySDK(), resource.WithHost(),
		resource.WithOS(), resource.WithProcessPID(), resource.WithProcessExecutableName(), resource.WithContainer(), resource.WithAttributes(attributes...))
}

type correlatedHandler struct{ next slog.Handler }

func (h correlatedHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h correlatedHandler) Handle(ctx context.Context, record slog.Record) error {
	spanContext := trace.SpanContextFromContext(ctx)
	if spanContext.IsValid() {
		record.AddAttrs(slog.String("trace_id", spanContext.TraceID().String()), slog.String("span_id", spanContext.SpanID().String()))
	}
	return h.next.Handle(ctx, record)
}

func (h correlatedHandler) WithAttrs(attributes []slog.Attr) slog.Handler {
	return correlatedHandler{next: h.next.WithAttrs(attributes)}
}

func (h correlatedHandler) WithGroup(name string) slog.Handler {
	return correlatedHandler{next: h.next.WithGroup(name)}
}

type fanoutHandler struct{ handlers []slog.Handler }

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

func (h fanoutHandler) WithAttrs(attributes []slog.Attr) slog.Handler {
	result := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		result = append(result, handler.WithAttrs(attributes))
	}
	return fanoutHandler{handlers: result}
}

func (h fanoutHandler) WithGroup(name string) slog.Handler {
	result := make([]slog.Handler, 0, len(h.handlers))
	for _, handler := range h.handlers {
		result = append(result, handler.WithGroup(name))
	}
	return fanoutHandler{handlers: result}
}
