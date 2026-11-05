package apierror

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestCommonErrorNewProjectsRegistryMetadata(t *testing.T) {
	for _, row := range []struct {
		code, category, message, requestID string
		retryable                          bool
	}{
		{"agent_not_ready", "conflict", "Agent is not ready", "req-1", true},
		{"lifecycle_timeout", "unavailable", "lifecycle operation timed out", "req-2", true},
		{"resource_version_conflict", "conflict", "changed concurrently", "req-3", false},
		{"runtime_image_invalid", "invalid_request", "image invalid", "req-4", false},
	} {
		envelope := New(row.code, row.message, row.requestID)
		if envelope.Code != row.code || envelope.Category != row.category ||
			envelope.Message != row.message || envelope.Retryable != row.retryable ||
			envelope.RequestID != row.requestID {
			t.Fatalf("envelope for %s = %+v", row.code, envelope)
		}
	}
}

func TestCommonErrorNewNormalizesUnknownCodes(t *testing.T) {
	envelope := New("ghost_code", "private-canary", "req-1")
	if envelope.Code != Internal || envelope.Category != "internal" ||
		envelope.Message != "Internal service error" || envelope.Retryable {
		t.Fatalf("unknown code not sanitized: %+v", envelope)
	}
	envelope = New(AgentNotReady, "Agent is not ready", "bad id!!")
	if envelope.RequestID == "bad id!!" || envelope.RequestID == "" {
		t.Fatalf("unsafe request id preserved: %+v", envelope)
	}
}

func TestCommonErrorWriteErrorEmitsEnvelope(t *testing.T) {
	response := httptest.NewRecorder()
	WriteError(response, 409, AgentNotReady, "Agent is not ready", true)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 409 || body["code"] != AgentNotReady || body["category"] != "conflict" ||
		body["retryable"] != true || body["message"] != "Agent is not ready" {
		t.Fatalf("body=%v status=%d", body, response.Code)
	}
	requestID, _ := body["request_id"].(string)
	if requestID == "" || requestID != response.Header().Get("X-Request-ID") ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("request id or no-store lost: %v headers=%v", body, response.Header())
	}
}
