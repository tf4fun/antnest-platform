package oidcclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
)

func TestOIDCAdapterObservesProtocolErrorInHTTP200WithoutProviderSecrets(t *testing.T) {
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"PROVIDER-CANARY","nested":{"token":"NESTED-CANARY"}}`))
	}))
	defer server.Close()
	httpClient := server.Client()
	httpClient.Transport = telemetry.NewHTTPTransport(httpClient.Transport)
	client, err := New(httpClient)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ExchangeAndVerify(t.Context(), oidcflow.ExchangeInput{Provider: oidcflow.Provider{
		ID: "provider-42", OrganizationID: "org-42", Revision: 7, TokenEndpoint: server.URL, TokenEndpointAuthMethod: "client_secret_basic",
	}, Code: "CODE-CANARY", ClientSecret: "SECRET-CANARY", PKCEVerifier: "PKCE-CANARY"})
	if err == nil {
		t.Fatal("OAuth error was lost")
	}
	var adapter, clientSpan sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.SpanKind() == trace.SpanKindInternal {
			adapter = span
		}
		if span.SpanKind() == trace.SpanKindClient {
			if clientSpan != nil {
				t.Fatal("duplicate CLIENT")
			}
			clientSpan = span
		}
		encoded, encodeErr := json.Marshal(span.Events())
		if encodeErr != nil {
			t.Fatal(encodeErr)
		}
		if strings.Contains(string(encoded), "CANARY") {
			t.Fatal("provider secret in trace")
		}
	}
	if adapter == nil || clientSpan == nil || adapter.Status().Code != codes.Error || clientSpan.Parent().SpanID() != adapter.SpanContext().SpanID() {
		t.Fatal("semantic adapter failure missing or wrong parent")
	}
	found := false
	for _, attr := range adapter.Attributes() {
		if string(attr.Key) == "antnest.error.protocol_code" && attr.Value.AsString() == "invalid_grant" {
			found = true
		}
	}
	if !found {
		t.Fatal("safe OAuth error code missing")
	}
}
