package apierror

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func commonEnvelope(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not a JSON object: %v", err)
	}
	return body
}

func TestCommonErrorWriteErrorProjectsRegistryMetadata(t *testing.T) {
	for code, meta := range metadata {
		response := httptest.NewRecorder()
		WriteError(response, meta.HTTPStatus, code, "Contract probe", meta.Retryable)
		if response.Code != meta.HTTPStatus {
			t.Fatalf("%s status = %d, want %d", code, response.Code, meta.HTTPStatus)
		}
		if response.Header().Get("Content-Type") != "application/json" ||
			response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s headers = %v", code, response.Header())
		}
		requestID := response.Header().Get("X-Request-ID")
		body := commonEnvelope(t, response)
		if body["code"] != code || body["category"] != meta.Category ||
			body["message"] != "Contract probe" || body["retryable"] != meta.Retryable ||
			body["request_id"] != requestID || len(body) != 5 {
			t.Fatalf("%s body = %v with header %q", code, body, requestID)
		}
	}
}

func TestCommonErrorWriteErrorRequestIDHandling(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "req-safe.1:x_y-z")
	WriteError(response, http.StatusBadRequest, InvalidRequest, "Bad", false)
	if got := commonEnvelope(t, response)["request_id"]; got != "req-safe.1:x_y-z" {
		t.Fatalf("safe request id was replaced: %v", got)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "unsafe id \x00!!")
	WriteError(response, http.StatusBadRequest, InvalidRequest, "Bad", false)
	id := response.Header().Get("X-Request-ID")
	if id == "unsafe id \x00!!" || !validRequestID(id) ||
		commonEnvelope(t, response)["request_id"] != id {
		t.Fatalf("unsafe request id survived: %q", id)
	}
	first, second := httptest.NewRecorder(), httptest.NewRecorder()
	WriteError(first, http.StatusInternalServerError, Internal, "boom", false)
	WriteError(second, http.StatusInternalServerError, Internal, "boom", false)
	if first.Header().Get("X-Request-ID") == "" ||
		first.Header().Get("X-Request-ID") == second.Header().Get("X-Request-ID") {
		t.Fatal("request ids were not freshly generated per call")
	}
}

func TestCommonErrorUnknownCodeSanitizes(t *testing.T) {
	response := httptest.NewRecorder()
	WriteError(response, http.StatusTeapot, "ghost_code", "private leak", true)
	body := commonEnvelope(t, response)
	if body["code"] != Internal || body["category"] != "internal" ||
		body["message"] != "Internal service error" || body["retryable"] != false {
		t.Fatalf("unknown code leaked its message: %v", body)
	}
	if response.Code != http.StatusTeapot {
		t.Fatal("caller status was not preserved for wire compatibility")
	}
	normalized := New("ghost_code", "private leak", "")
	if normalized.Code != Internal || normalized.Message != "Internal service error" ||
		normalized.Retryable || !validRequestID(normalized.RequestID) {
		t.Fatalf("New() = %+v", normalized)
	}
	known := New(CredentialBusy, "busy", "")
	if known.Category != "unavailable" || !known.Retryable {
		t.Fatalf("New() = %+v", known)
	}
}
