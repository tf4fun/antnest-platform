package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	collectormetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

func isolateMetricsEnvironment(t *testing.T) {
	t.Helper()
	for _, setting := range os.Environ() {
		key, _, _ := strings.Cut(setting, "=")
		if strings.HasPrefix(key, "OTEL_") {
			t.Setenv(key, "")
		}
	}
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "3600000")
	tracer, meter, propagator := otel.GetTracerProvider(), otel.GetMeterProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(tracer)
		otel.SetMeterProvider(meter)
		otel.SetTextMapPropagator(propagator)
	})
}

func TestMetricsOnlyExportsRealOTLPAndFlushesAtShutdown(t *testing.T) {
	for _, endpoint := range []string{"generic", "signal-specific", "signal-overrides-generic"} {
		t.Run(endpoint, func(t *testing.T) {
			isolateMetricsEnvironment(t)
			exports := make(chan *collectormetrics.ExportMetricsServiceRequest, 4)
			paths := make(chan string, 4)
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				var message collectormetrics.ExportMetricsServiceRequest
				if err != nil || proto.Unmarshal(body, &message) != nil || r.Header.Get("Content-Type") != "application/x-protobuf" {
					t.Error("receiver did not receive valid OTLP HTTP/protobuf metrics")
					w.WriteHeader(400)
					return
				}
				paths <- r.URL.Path
				exports <- &message
				w.Header().Set("Content-Type", "application/x-protobuf")
			}))
			defer receiver.Close()
			t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
			wantPath := "/v1/metrics"
			if endpoint == "generic" {
				t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.URL)
			} else {
				wantPath = "/gateway-metrics"
				t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", receiver.URL+wantPath)
				if endpoint == "signal-overrides-generic" {
					t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
				}
			}
			runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{ServiceVersion: "test-build", Environment: "test"})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = runtime.Shutdown(context.Background()) }()
			counter, err := otel.Meter("gateway-metrics-test").Int64Counter("test.gateway.resolve")
			if err != nil {
				t.Fatal(err)
			}
			counter.Add(context.Background(), 7)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := runtime.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case message := <-exports:
				if path := <-paths; path != wantPath {
					t.Fatalf("metrics endpoint path = %q, want %q", path, wantPath)
				}
				found, resourceFound := false, false
				for _, resource := range message.ResourceMetrics {
					attributes := map[string]string{}
					for _, value := range resource.Resource.Attributes {
						attributes[value.Key] = value.Value.GetStringValue()
					}
					resourceFound = attributes["service.name"] == "edge-gateway" && attributes["service.version"] == "test-build" && attributes["deployment.environment.name"] == "test"
					for _, scope := range resource.ScopeMetrics {
						for _, metric := range scope.Metrics {
							if metric.Name == "test.gateway.resolve" && len(metric.GetSum().GetDataPoints()) == 1 && metric.GetSum().DataPoints[0].GetAsInt() == 7 {
								found = true
							}
						}
					}
				}
				if !found || !resourceFound {
					t.Fatal("wire payload omitted the final measurement or Gateway resource")
				}
			default:
				t.Fatal("metrics-only setup silently used a no-op provider or skipped final flush")
			}
			select {
			case <-exports:
				t.Fatal("shutdown exported the same final measurement more than once")
			default:
			}
		})
	}
}

func TestMetricsSignalConfiguration(t *testing.T) {
	for _, test := range []struct {
		name, exporter, genericProtocol, metricsProtocol string
		disabled, wantError                              bool
	}{
		{"none ignores protocol", "none", "grpc", "", false, false},
		{"disabled ignores signal configuration", "invalid", "grpc", "", true, false},
		{"unsupported exporter", "prometheus", "", "", false, true},
		{"unsupported generic protocol", "otlp", "grpc", "", false, true},
		{"unsupported metric protocol", "otlp", "http/protobuf", "grpc", false, true},
		{"specific protocol takes precedence", "otlp", "grpc", "http/protobuf", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			isolateMetricsEnvironment(t)
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "application/x-protobuf")
			}))
			defer receiver.Close()
			t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", receiver.URL+"/v1/metrics")
			t.Setenv("OTEL_METRICS_EXPORTER", test.exporter)
			t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", test.genericProtocol)
			t.Setenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", test.metricsProtocol)
			if test.disabled {
				t.Setenv("OTEL_SDK_DISABLED", "true")
			}
			runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{})
			if runtime != nil {
				defer func() {
					if err := runtime.Shutdown(context.Background()); err != nil {
						t.Error(err)
					}
				}()
			}
			if (err != nil) != test.wantError {
				t.Fatalf("configuration error = %v, want error %t", err, test.wantError)
			}
		})
	}
}

func TestMetricsExportFailureDoesNotSkipTraceFlush(t *testing.T) {
	isolateMetricsEnvironment(t)
	var mu sync.Mutex
	paths := map[string]int{}
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		paths[r.URL.Path]++
		mu.Unlock()
		if r.URL.Path == "/v1/metrics" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer receiver.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.URL)
	t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = runtime.Shutdown(context.Background()) }()
	counter, err := otel.Meter("test").Int64Counter("test.gateway.resolve")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 1)
	_, span := otel.Tracer("test").Start(context.Background(), "pending Gateway trace")
	span.End()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err == nil {
		t.Error("failed final metrics export was hidden")
	}
	mu.Lock()
	defer mu.Unlock()
	if paths["/v1/metrics"] != 1 || paths["/v1/traces"] != 1 {
		t.Fatalf("independent signal flushes missing: %v", paths)
	}
}
