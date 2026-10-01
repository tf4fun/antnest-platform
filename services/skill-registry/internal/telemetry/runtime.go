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
)

const instrumentationName = "github.com/tf4fun/antnest-platform/skill-registry"

type Runtime struct{ provider *sdktrace.TracerProvider }

func Setup(ctx context.Context) (*Runtime, error) {
	enabled, err := traceExportEnabled()
	if err != nil {
		return nil, err
	}
	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) {
		slog.Error("OpenTelemetry export failed", "error_class", "export_error")
	}))
	if !enabled {
		// Keep new child IDs and incoming W3C context when no exporter is installed.
		provider := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.NeverSample())))
		otel.SetTracerProvider(provider)
		return &Runtime{provider: provider}, nil
	}
	service := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME"))
	if service == "" {
		service = "skill-registry"
	}
	res, err := resource.New(ctx, resource.WithFromEnv(), resource.WithTelemetrySDK(), resource.WithContainer(),
		resource.WithAttributes(attribute.String("service.name", service), attribute.String("service.namespace", "antnest")))
	if err != nil {
		return nil, fmt.Errorf("create Registry telemetry resource: %w", err)
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("create Registry OTLP trace exporter: %w", err)
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(provider)
	return &Runtime{provider: provider}, nil
}

func traceExportEnabled() (bool, error) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return false, nil
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OTEL_TRACES_EXPORTER"))) {
	case "none":
		return false, nil
	case "", "otlp":
	default:
		return false, fmt.Errorf("OTEL_TRACES_EXPORTER supports only otlp or none")
	}
	if strings.TrimSpace(os.Getenv("OTEL_TRACES_EXPORTER")) == "" && strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) == "" && strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) == "" {
		return false, nil
	}
	key := "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"
	protocol := strings.TrimSpace(os.Getenv(key))
	if protocol == "" {
		key = "OTEL_EXPORTER_OTLP_PROTOCOL"
		protocol = strings.TrimSpace(os.Getenv(key))
	}
	if protocol != "" && !strings.EqualFold(protocol, "http/protobuf") {
		return false, fmt.Errorf("%s supports only http/protobuf", key)
	}
	return true, nil
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
