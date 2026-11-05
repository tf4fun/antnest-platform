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
		{"agent_mutation_in_progress", "conflict", "still in progress", "req-1", true},
		{"deadline_exceeded", "unavailable", "deadline exceeded", "req-2", true},
		{"runtime_revision_conflict", "conflict", "revision stale", "req-3", false},
		{"observation_cursor_expired", "not_found", "cursor outside journal", "req-4", false},
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
	envelope = New(DeadlineExceeded, "deadline exceeded", "bad id!!")
	if envelope.RequestID == "bad id!!" || envelope.RequestID == "" {
		t.Fatalf("unsafe request id preserved: %+v", envelope)
	}
}

func TestCommonErrorWriteErrorEmitsEnvelope(t *testing.T) {
	response := httptest.NewRecorder()
	WriteError(response, 503, SkillPreflightUnavailable, "preflight is unavailable", true)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != 503 || body["code"] != SkillPreflightUnavailable || body["category"] != "unavailable" ||
		body["retryable"] != true {
		t.Fatalf("body=%v status=%d", body, response.Code)
	}
	requestID, _ := body["request_id"].(string)
	if requestID == "" || requestID != response.Header().Get("X-Request-ID") ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("request id or no-store lost: %v headers=%v", body, response.Header())
	}
}
