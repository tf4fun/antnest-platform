package telemetry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func capturedPayloadEvent(span sdktrace.ReadOnlySpan, event string) string {
	for _, item := range span.Events() {
		if item.Name != event {
			continue
		}
		for _, attr := range item.Attributes {
			if attr.Key == attribute.Key("antnest.payload.json") {
				return attr.Value.AsString()
			}
		}
	}
	return ""
}

func TestRPCCaptureRedactsNestedSecrets(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder, _ := contractRecorder(t)
	payload := map[string]any{
		"public": "retained",
		"nested": map[string]any{
			"password":     "PRIVATE-CANARY",
			"access_token": "PRIVATE-CANARY",
		},
		"rows": []map[string]any{{"client_secret": "PRIVATE-CANARY"}},
	}
	response := httptest.NewRecorder()
	handler := HTTPHandler(RPCHandler("fixture", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ObserveRequest(r.Context(), payload)
		ObserveResponse(w, payload)
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			t.Fatal(err)
		}
	})))
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/rpc", strings.NewReader("{}")))
	body := response.Body.String()
	if !strings.Contains(body, "PRIVATE-CANARY") || !strings.Contains(body, "retained") {
		t.Fatalf("wire body changed: %s", body)
	}
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("spans=%d", len(ended))
	}
	for _, event := range []string{"antnest.request", "antnest.response"} {
		captured := capturedPayloadEvent(ended[0], event)
		if captured == "" {
			t.Fatalf("%s payload missing", event)
		}
		if strings.Contains(captured, "PRIVATE-CANARY") {
			t.Fatalf("%s leaked secret value: %s", event, captured)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(captured), &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded["public"] != "retained" {
			t.Fatalf("public field lost: %s", captured)
		}
		nested, _ := decoded["nested"].(map[string]any)
		if nested["password"] != "[REDACTED]" || nested["access_token"] != "[REDACTED]" {
			t.Fatalf("nested secrets not redacted: %s", captured)
		}
		rows, _ := decoded["rows"].([]any)
		if len(rows) != 1 {
			t.Fatalf("rows lost: %s", captured)
		}
		row, _ := rows[0].(map[string]any)
		if row["client_secret"] != "[REDACTED]" {
			t.Fatalf("array secret not redacted: %s", captured)
		}
	}
}

type panicOnMarshalProbe struct{}

func (panicOnMarshalProbe) MarshalJSON() ([]byte, error) {
	panic("suppressed payload must never serialize")
}

func TestSuppressedRPCNeverSerializesSecret(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder, _ := contractRecorder(t)
	response := httptest.NewRecorder()
	handler := HTTPHandler(RPCHandler("fixture", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SuppressRPCContent(r.Context())
		ObserveRequest(r.Context(), panicOnMarshalProbe{})
		ObserveResponse(w, panicOnMarshalProbe{})
		w.WriteHeader(http.StatusNoContent)
	})))
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/rpc", strings.NewReader("{}")))
	ended := recorder.Ended()
	if len(ended) != 1 {
		t.Fatalf("spans=%d", len(ended))
	}
	for _, item := range ended[0].Events() {
		if strings.HasPrefix(item.Name, "antnest.") {
			t.Fatalf("suppressed RPC emitted %s", item.Name)
		}
	}
}
