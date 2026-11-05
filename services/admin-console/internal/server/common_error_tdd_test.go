package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

var commonErrorRequestID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func commonErrorEnvelope(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("error response is not a JSON object: %v", err)
	}
	return body
}

func assertCommonErrorEnvelope(t *testing.T, response *httptest.ResponseRecorder, status int, code, category string, retryable bool) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("%s status = %d, want %d", code, response.Code, status)
	}
	body := commonErrorEnvelope(t, response)
	requestID, _ := body["request_id"].(string)
	if body["code"] != code || body["category"] != category || body["retryable"] != retryable {
		t.Fatalf("%s envelope = %v", code, body)
	}
	if requestID == "" || !commonErrorRequestID.MatchString(requestID) ||
		requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("%s request_id = %q with X-Request-ID %q", code, requestID, response.Header().Get("X-Request-ID"))
	}
}

func TestCommonErrorTDDLocal(t *testing.T) {
	for _, row := range []struct {
		name      string
		status    int
		code      string
		category  string
		retryable bool
	}{
		{"invalid", http.StatusBadRequest, "invalid_request", "invalid_request", false},
		{"denied", http.StatusForbidden, "forbidden", "forbidden", false},
		{"missing", http.StatusNotFound, "not_found", "not_found", false},
		{"saturated", http.StatusTooManyRequests, "busy", "rate_limited", true},
		{"outage", http.StatusServiceUnavailable, "dependency_unavailable", "unavailable", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, row.status, row.code, "Contract probe")
			assertCommonErrorEnvelope(t, response, row.status, row.code, row.category, row.retryable)
			if body := commonErrorEnvelope(t, response); body["message"] != "Contract probe" {
				t.Fatalf("%s message lost: %v", row.code, body)
			}
		})
	}
}

func TestCommonErrorTDDRouteProjection(t *testing.T) {
	t.Run("flat-legacy", func(t *testing.T) {
		backend := newBackendStub()
		backend.enqueue(403, `{"code":"forbidden","message":"denied"}`)
		handler := newTestHandler(t, backend)
		response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory", "")
		assertCommonErrorEnvelope(t, response, 403, "forbidden", "forbidden", false)
		if body := commonErrorEnvelope(t, response); body["message"] != "denied" {
			t.Fatalf("legacy message lost: %v", body)
		}
	})
	for _, row := range []struct {
		name    string
		payload string
	}{
		{"flat-new", `{"code":"not_found","message":"gone","category":"not_found","retryable":false,"request_id":"upstream-1","details":{"private_canary":"token"}}`},
		{"nested-new", `{"error":{"code":"not_found","message":"gone","category":"not_found","retryable":false,"request_id":"upstream-1","details":{"private_canary":"token"}}}`},
	} {
		t.Run(row.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(404, row.payload)
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodGet, "/api/admin/directory", "")
			assertCommonErrorEnvelope(t, response, 404, "not_found", "not_found", false)
			body := commonErrorEnvelope(t, response)
			if body["message"] != "gone" {
				t.Fatalf("upstream message lost: %v", body)
			}
			if strings.Contains(response.Body.String(), "private_canary") {
				t.Fatal("upstream details were reflected")
			}
			if id, _ := body["request_id"].(string); id == "upstream-1" {
				t.Fatal("upstream request_id was reflected")
			}
		})
	}
}
