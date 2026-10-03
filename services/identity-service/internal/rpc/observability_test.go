package rpc

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
)

type observedLoginService struct{ *rpcServicesStub }

func (s observedLoginService) Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error) {
	return localauth.LoginResult{Principal: domain.Principal{UserID: "user-42", OrganizationID: "org-42", MembershipID: "member-42", Active: true}, TokenID: "token-42", AccessToken: "ACCESS-CANARY"}, nil
}

func TestLoginDispatcherCapturesActualDTOValuesAndPreservesCredentialWire(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) })
	stub := &rpcServicesStub{}
	handler := authenticatedBusinessHandler(t, Dependencies{Directory: stub, LocalAuth: observedLoginService{stub}, OIDC: stub, SCIM: stub})
	request := httptest.NewRequest(http.MethodPost, ContractRoutes["local_login"], strings.NewReader(`{"request_id":"request-42","organization_slug":"engineering","email":"EMAIL-CANARY@example.com","password":"PASSWORD-CANARY"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	response := httptest.NewRecorder()
	telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "ACCESS-CANARY") {
		t.Fatal("login wire changed")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Parent().SpanID().String() != "00f067aa0ba902b7" {
		t.Fatal("dispatcher created an extra span or lost parent")
	}
	var requestJSON, responseJSON string
	for _, event := range spans[0].Events() {
		for _, attr := range event.Attributes {
			if string(attr.Key) == "antnest.payload.json" {
				if event.Name == "antnest.request" {
					requestJSON = attr.Value.AsString()
				}
				if event.Name == "antnest.response" {
					responseJSON = attr.Value.AsString()
				}
			}
		}
	}
	if !strings.Contains(requestJSON, `"request_id":"request-42"`) || !strings.Contains(responseJSON, `"user_id":"user-42"`) || !strings.Contains(responseJSON, `"organization_id":"org-42"`) || !strings.Contains(responseJSON, `"active":true`) {
		t.Fatalf("actual values missing: %s %s", requestJSON, responseJSON)
	}
	if !strings.Contains(requestJSON, "PASSWORD-CANARY") || !strings.Contains(responseJSON, "ACCESS-CANARY") {
		t.Fatal("enabled RPC capture must preserve complete parameters and results")
	}
}

func TestIssuedCallerContextIsOmittedFromEnabledRPCCapture(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	previous := otel.GetTracerProvider()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()); otel.SetTracerProvider(previous) })
	stub := &rpcServicesStub{}
	handler := authenticatedBusinessHandler(t, Dependencies{Directory: stub, LocalAuth: stub, OIDC: stub, SCIM: stub})
	request := httptest.NewRequest("POST", ContractRoutes["resolve_access_token"], strings.NewReader(`{"access_token":"user-access-token","profile":"console"}`))
	response := httptest.NewRecorder()
	telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, request)
	var result struct {
		CallerContext string `json:"caller_context"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.CallerContext == "" {
		t.Fatal("CCT issuance failed")
	}
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatal("expected issuance span")
	}
	for _, event := range spans[0].Events() {
		for _, attr := range event.Attributes {
			if strings.Contains(attr.Value.AsString(), result.CallerContext) || strings.Contains(attr.Value.AsString(), `"caller_context"`) {
				t.Fatal("CCT leaked into trace")
			}
		}
	}
}
