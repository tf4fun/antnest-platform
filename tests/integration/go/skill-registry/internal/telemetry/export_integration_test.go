package telemetry

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestOTLPHTTPShutdownExportsNativeRegistryMetadataOnly(t *testing.T) {
	exported := make(chan []byte, 4)
	collectorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/traces" || r.Header.Get("Content-Type") != "application/x-protobuf" {
			t.Error("unexpected OTLP export protocol")
			w.WriteHeader(400)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(500)
			return
		}
		exported <- body
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	defer collectorServer.Close()
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collectorServer.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "")
	t.Setenv("OTEL_SERVICE_NAME", "skill-registry")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
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
	mux := http.NewServeMux()
	mux.HandleFunc("POST /known/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("private-response"))
	})
	request := httptest.NewRequest(http.MethodPost, "/known/private-id?private-query=secret", strings.NewReader("private-body"))
	request.Header.Set("Authorization", "Bearer private-token")
	rec := httptest.NewRecorder()
	HTTPHandler(mux).ServeHTTP(rec, request)
	if rec.Code != 200 || rec.Body.String() != "private-response" {
		t.Fatal("exporter changed business response")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := runtime.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-exported:
		var payload collector.ExportTraceServiceRequest
		if err := proto.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		spans := 0
		for _, resource := range payload.ResourceSpans {
			service := ""
			for _, attr := range resource.Resource.Attributes {
				if attr.Key == "service.name" {
					service = attr.Value.GetStringValue()
				}
			}
			if service != "skill-registry" {
				t.Fatalf("wrong service resource: %s", service)
			}
			for _, scope := range resource.ScopeSpans {
				for _, span := range scope.Spans {
					spans++
					if span.Name != "HTTP POST /known/{id}" || len(span.Events) != 0 {
						t.Fatal("native export lost the route template/content boundary")
					}
				}
			}
		}
		if spans != 1 || strings.Contains(string(body), "private-") {
			t.Fatal("unexpected export count or private content")
		}
	default:
		t.Fatal("shutdown did not flush completed spans")
	}
}
