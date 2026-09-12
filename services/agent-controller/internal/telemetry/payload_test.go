package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

func TestCaptureDisabledDoesNotSerialize(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "false")
	recorder := boundaryRecorder(t)
	handler := RPCHandler("test", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		CaptureDTO(w, "request", marshalProbe{})
		CaptureDTO(w, "response", marshalProbe{})
	}))
	HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	if len(recorder.Ended()[0].Events()) != 0 {
		t.Fatal("disabled capture emitted events")
	}
}

type marshalProbe struct{}

func (marshalProbe) MarshalJSON() ([]byte, error) { panic("disabled capture serialized DTO") }

func TestRPCUnknownFieldsAndCollectionsAreCaptured(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := boundaryRecorder(t)
	value := map[string]any{"new_field": strings.Repeat("canary", 4000), "items": make([]string, 100)}
	expected, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	handler := RPCHandler("test", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { CaptureDTO(w, "response", value) }))
	HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	var captured string
	for _, event := range recorder.Ended()[0].Events() {
		if event.Name == "antnest.response" {
			for _, attr := range event.Attributes {
				if attr.Key == "antnest.payload.json" {
					captured = attr.Value.AsString()
				}
			}
		}
	}
	if captured != string(expected) {
		t.Fatal("RPC contents were projected or limited")
	}
}

func TestErrorContractTypesAndSecretCause(t *testing.T) {
	recorder := boundaryRecorder(t)
	ctx, span := otel.Tracer("test").Start(t.Context(), "error")
	RecordBoundaryError(ctx, errors.Join(context.DeadlineExceeded, errors.New("access_token=canary")), "decode", "invalid_response", "response validation failed", true)
	span.End()
	attrs := map[string]attribute.Value{}
	for _, attr := range recorder.Ended()[0].Events()[0].Attributes {
		attrs[string(attr.Key)] = attr.Value
		if strings.Contains(attr.Value.String(), "canary") {
			t.Fatal("raw cause leaked")
		}
	}
	for _, key := range []string{"antnest.error.stage", "antnest.error.type", "antnest.error.code", "antnest.error.message", "error.type"} {
		if attrs[key].Type() != attribute.STRING || attrs[key].AsString() == "" {
			t.Fatalf("invalid type/value for %s", key)
		}
	}
	if attrs["antnest.error.cause_types"].Type() != attribute.STRINGSLICE {
		t.Fatal("cause_types must be string[]")
	}
	var causes []string
	if err := json.Unmarshal([]byte(attrs["antnest.error.causes"].AsString()), &causes); err != nil || len(causes) > 4 {
		t.Fatal("causes are not bounded JSON")
	}
}

func TestHTTPStreamingDoesNotAccumulatePayloadAndPreservesFlush(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := boundaryRecorder(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /watch", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for range 64 {
			if _, err := io.WriteString(w, "data: "+strings.Repeat("canary", 100)+"\n\n"); err != nil {
				t.Fatal(err)
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Fatal(err)
			}
			if len(recorder.Ended()) != 0 {
				t.Fatal("stream ended at headers")
			}
		}
	})
	response := httptest.NewRecorder()
	HTTPHandler(mux, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/watch", nil))
	if !response.Flushed || response.Body.Len() <= 16<<10 {
		t.Fatal("stream behavior changed")
	}
	span := recorder.Ended()[0]
	if span.Status().Code == codes.Error || len(span.Events()) != 0 {
		t.Fatal("per-chunk events or stream failure")
	}
	for _, event := range span.Events() {
		for _, attr := range event.Attributes {
			if strings.Contains(attr.Value.String(), "canary") {
				t.Fatal("stream body captured")
			}
		}
	}
}
