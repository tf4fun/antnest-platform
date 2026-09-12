package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestModelEditRequiresCallerVersionWithoutUpstreamRead(t *testing.T) {
	for _, version := range []string{"", `,"expected_version":0`, `,"expected_version":-1`, `,"expected_version":null`, `,"expected_version":1.5`} {
		backend := newBackendStub()
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/model-profiles/model-1/revisions",
			`{"display_name":"Model","model":{"model":"deepseek-chat"}`+version+`}`)
		if response.Code != http.StatusBadRequest || len(backend.calls) != 0 {
			t.Fatalf("invalid version reached Controller: status=%d calls=%d", response.Code, len(backend.calls))
		}
	}
}

func TestModelEditForwardsStaleVersionAndConflictWithoutRetry(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusConflict, `{"code":"lifecycle_conflict","message":"resource changed concurrently","retryable":false}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/model-profiles/model-1/revisions",
		`{"expected_version":3,"display_name":"Model","model":{"model":"deepseek-chat"}}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "lifecycle_conflict") {
		t.Fatalf("lost conflict: status=%d body=%s", response.Code, response.Body)
	}
	call := backend.singleCall(t)
	var payload map[string]any
	decodeBytes(t, call.Body, &payload)
	if payload["expected_version"] != float64(3) || call.Method != http.MethodPost {
		t.Fatalf("BFF replaced the caller version: %v", payload)
	}
}
