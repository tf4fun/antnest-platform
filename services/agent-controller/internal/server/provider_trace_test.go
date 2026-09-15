package server

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestProviderCredentialRoutesNeverCapturePayload(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := networkPolicyTraceRecorder(t)
	for _, path := range []string{"/internal/provider-connections", "/internal/provider-connections/provider-1/credentials"} {
		for _, outcome := range []string{"success", "invalid", "dependency"} {
			t.Run(path+"/"+outcome, func(t *testing.T) {
				service := &catalogServiceStub{}
				if outcome == "dependency" {
					service.getModelErr = application.ErrDependencyUnavailable
				}
				handler, err := NewHandler(service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
				if err != nil {
					t.Fatal(err)
				}
				body := `{"request_id":"test","organization_id":"org-1","credential":{"method":"api_key","api_key":"stage2-model-secret"}}`
				if outcome == "invalid" {
					body = strings.TrimSuffix(body, "}") + `,"unexpected":"stage2-model-secret"}`
				}
				before := len(recorder.Ended())
				response := httptest.NewRecorder()
				telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
				expected := map[string]int{"success": http.StatusCreated, "invalid": http.StatusBadRequest, "dependency": http.StatusServiceUnavailable}[outcome]
				if response.Code != expected {
					t.Fatalf("status = %d, want %d", response.Code, expected)
				}
				spans := recorder.Ended()[before:]
				if len(spans) != 1 {
					t.Fatalf("HTTP boundary count = %d", len(spans))
				}
				assertProviderMetadataOnly(t, spans[0])
			})
		}
	}
}

func TestProviderReadRetainsNonSecretRPCDiagnostics(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := networkPolicyTraceRecorder(t)
	handler, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/provider-connections/provider-1?organization_id=org-1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	for _, event := range recorder.Ended()[0].Events() {
		if event.Name == "antnest.response" {
			return
		}
	}
	t.Fatal("non-secret RPC positive capture control missing")
}

func TestProviderAccessIsMetadataOnlyEvenWithContentCaptureEnabled(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := networkPolicyTraceRecorder(t)
	handler, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/internal/provider-connections/provider-1/access?organization_id=org-1", nil))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), "synthetic") {
		t.Fatalf("access contract not satisfied: status %d", response.Code)
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("boundary spans = %d", len(spans))
	}
	assertProviderMetadataOnly(t, spans[0])
}

func assertProviderMetadataOnly(t *testing.T, span sdktrace.ReadOnlySpan) {
	t.Helper()
	for _, event := range span.Events() {
		if event.Name == "antnest.request" || event.Name == "antnest.response" {
			t.Fatal("credential-bearing route captured payload")
		}
		if strings.Contains(fmt.Sprint(event.Attributes), "stage2-model-secret") {
			t.Fatal("credential leaked into diagnostics")
		}
	}
	if strings.Contains(fmt.Sprint(span.Attributes()), "stage2-model-secret") {
		t.Fatal("credential leaked into span attributes")
	}
}
