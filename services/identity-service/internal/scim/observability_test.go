package scim

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
)

func TestSCIMRecordsMetadataWithoutContent(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) })
	store := &scimRepositoryStub{authorization: Authorization{TokenID: "token-1", OrganizationID: "org-42", Scopes: []string{"scim:write"}}}
	handler, err := NewHTTPHandler(newSCIMTestService(t, store), "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	response := requestSCIM(t, telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))), http.MethodPost, "/scim/v2/Users", map[string]any{
		"schemas": []string{userSchema}, "externalId": "EXTERNAL-CANARY", "userName": "USERNAME-CANARY",
		"active": true, "emails": []map[string]any{{"value": "EMAIL-CANARY@example.com", "primary": true}},
		"extension": map[string]any{"password": "NESTED-CANARY", "child": []any{map[string]any{"token": "TOKEN-CANARY"}}},
	})
	if response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	if len(recorder.Ended()) != 1 {
		t.Fatal("expected one SCIM SERVER")
	}
	span := recorder.Ended()[0]
	if span.Name() != "HTTP POST /scim/v2/Users" {
		t.Fatal(span.Name())
	}
	if len(span.Events()) != 0 {
		t.Fatal("SCIM generated content events")
	}
	hasOrganization := false
	for _, attr := range span.Attributes() {
		if string(attr.Key) == "antnest.organization.id" && attr.Value.AsString() == "org-42" {
			hasOrganization = true
		}
	}
	if !hasOrganization {
		t.Fatal("authenticated organization metadata missing")
	}
	encoded, err := json.Marshal(span.Events())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "CANARY") {
		t.Fatal("SCIM profile escaped")
	}
}
