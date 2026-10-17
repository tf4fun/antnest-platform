package telemetry

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	collectormetrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/proto"
)

type exportedProcessIdentity struct {
	signal, host, instance string
	pid                    int64
}

func emitProcessIdentity(t *testing.T) {
	t.Helper()
	runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Shutdown(context.Background()) })
	_, span := otel.Tracer("gateway-process-test").Start(context.Background(), "process-identity")
	span.End()
	counter, err := otel.Meter("gateway-process-test").Int64Counter("test.gateway.process")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestTelemetryResourcesIdentifyActualProcess(t *testing.T) {
	isolateMetricsEnvironment(t)
	exports := make(chan exportedProcessIdentity, 16)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || r.Header.Get("Content-Type") != "application/x-protobuf" {
			t.Error("invalid OTLP request")
			w.WriteHeader(400)
			return
		}
		var attributes []*commonpb.KeyValue
		switch r.URL.Path {
		case "/v1/traces":
			var message collectortrace.ExportTraceServiceRequest
			if proto.Unmarshal(body, &message) != nil || len(message.ResourceSpans) != 1 || len(message.ResourceSpans[0].ScopeSpans) != 1 || len(message.ResourceSpans[0].ScopeSpans[0].Spans) != 1 || message.ResourceSpans[0].ScopeSpans[0].Spans[0].Name != "process-identity" {
				t.Error("missing actual trace export")
				w.WriteHeader(400)
				return
			}
			attributes = message.ResourceSpans[0].Resource.Attributes
		case "/v1/metrics":
			var message collectormetrics.ExportMetricsServiceRequest
			if proto.Unmarshal(body, &message) != nil || len(message.ResourceMetrics) != 1 || len(message.ResourceMetrics[0].ScopeMetrics) != 1 || len(message.ResourceMetrics[0].ScopeMetrics[0].Metrics) != 1 || message.ResourceMetrics[0].ScopeMetrics[0].Metrics[0].Name != "test.gateway.process" {
				t.Error("missing actual metric export")
				w.WriteHeader(400)
				return
			}
			attributes = message.ResourceMetrics[0].Resource.Attributes
		default:
			t.Errorf("unexpected OTLP path %q", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		fields := make(map[string]*commonpb.AnyValue)
		for _, field := range attributes {
			if _, exists := fields[field.Key]; exists {
				t.Errorf("duplicate resource field %q", field.Key)
			}
			fields[field.Key] = field.Value
		}
		if fields["service.name"].GetStringValue() != "edge-gateway" || fields["service.namespace"].GetStringValue() != "antnest" || fields["test.deployment"].GetStringValue() != "retained" {
			t.Error("process identity changed existing resource settings")
		}
		exports <- exportedProcessIdentity{r.URL.Path, fields["host.name"].GetStringValue(), fields["service.instance.id"].GetStringValue(), fields["process.pid"].GetIntValue()}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer receiver.Close()
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
	t.Setenv("OTEL_SERVICE_NAME", "edge-gateway")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.URL)
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "host.name=forged-host,process.pid=999999,service.instance.id=forged-instance,test.deployment=retained")
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	read := func(pid int) string {
		t.Helper()
		seen := map[string]bool{}
		instance := ""
		for range 2 {
			select {
			case row := <-exports:
				if seen[row.signal] {
					t.Fatalf("duplicate %s export", row.signal)
				}
				seen[row.signal] = true
				if row.host != host || row.pid != int64(pid) || row.instance == "" || row.instance == "forged-instance" {
					t.Errorf("OTLP %s omitted actual process identity: %+v; want host=%q pid=%d", row.signal, row, host, pid)
				}
				if instance != "" && row.instance != instance {
					t.Error("trace and metric resources identify different processes")
				}
				instance = row.instance
			case <-time.After(2 * time.Second):
				t.Fatal("missing completed OTLP export")
			}
		}
		return instance
	}
	emitProcessIdentity(t)
	first := read(os.Getpid())
	emitProcessIdentity(t)
	if second := read(os.Getpid()); first != second {
		t.Error("recreating telemetry changed the identity of the same process")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTelemetryProcessIdentityChild$")
	child.Env = append(os.Environ(), "ANTNEST_TELEMETRY_IDENTITY_CHILD=1")
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("child telemetry export failed: %v\n%s", err, output)
	}
	if next := read(child.Process.Pid); next == first {
		t.Error("different processes share a telemetry instance identity")
	}
	if len(exports) != 0 {
		t.Fatal("unexpected additional telemetry exports")
	}
}

func TestTelemetryProcessIdentityChild(t *testing.T) {
	if os.Getenv("ANTNEST_TELEMETRY_IDENTITY_CHILD") == "1" {
		emitProcessIdentity(t)
	}
}
