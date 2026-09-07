package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestResolveImageUsesReadOnlyContractAndTrace(t *testing.T) {
	previous := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previous) })
	parent := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled,
	})
	reference := "registry.example:5000/team/runtime:v1"
	imageID := "sha256:" + strings.Repeat("a", 64)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/internal/runtime-images/resolve" ||
			request.URL.Query().Get("reference") != reference || len(request.URL.Query()) != 1 ||
			request.Header.Get("Idempotency-Key") != "" {
			t.Errorf("unexpected image lookup: %s %s", request.Method, request.URL)
		}
		ctx := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		if trace.SpanContextFromContext(ctx).TraceID() != parent.TraceID() {
			t.Error("image lookup lost request trace")
		}
		if err := json.NewEncoder(response).Encode(map[string]string{"reference": reference, "image_ref": imageID}); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.ResolveImage(trace.ContextWithSpanContext(context.Background(), parent), reference)
	if err != nil || result.Reference != reference || result.ImageRef != imageID {
		t.Fatalf("image = %+v, err = %v", result, err)
	}
}

func TestResolveImageRejectsInvalidResponsesAndPreservesFailureCode(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"mutable identity", 200, `{"reference":"runtime:v1","image_ref":"runtime:v1"}`, "invalid_response"},
		{"missing source", 200, `{"image_ref":"sha256:` + strings.Repeat("a", 64) + `"}`, "invalid_response"},
		{"malformed", 200, `{`, "invalid_response"},
		{"oversized", 200, strings.Repeat(" ", maximumResponseBytes+1), "invalid_response"},
		{"missing image", 404, `{"code":"image_not_found","message":"private details","retryable":false}`, "image_not_found"},
		{"timeout", 504, `{"code":"deadline_exceeded","retryable":true}`, "deadline_exceeded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(test.status)
				if _, err := response.Write([]byte(test.body)); err != nil {
					t.Error(err)
				}
			}))
			t.Cleanup(server.Close)
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ResolveImage(context.Background(), "runtime:v1")
			var failure *ports.DependencyError
			if !errors.As(err, &failure) || failure.Code != test.code || strings.Contains(err.Error(), "private details") {
				t.Fatalf("failure = %v", err)
			}
		})
	}
}
