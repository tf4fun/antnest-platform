package telemetry

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func rpcPayloadValue(span sdktrace.ReadOnlySpan, event string) string {
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
	recorder := boundaryRecorder(t)
	payload := map[string]any{
		"public": "retained",
		"nested": map[string]any{
			"password":     "PRIVATE-CANARY",
			"access_token": "PRIVATE-CANARY",
		},
		"rows": []map[string]any{{"client_secret": "PRIVATE-CANARY"}},
	}
	response := httptest.NewRecorder()
	handler := HTTPHandler(RPCHandler("fixture", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		CaptureDTO(w, "request", payload)
		CaptureDTO(w, "response", payload)
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			t.Fatal(err)
		}
	})), slog.New(slog.NewTextHandler(io.Discard, nil)))
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
		captured := rpcPayloadValue(ended[0], event)
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
