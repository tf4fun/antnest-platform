package rpc

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

var rpcSafeID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func commonErrorBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("failure body is not an object: %v", err)
	}
	return body
}

func assertCommonError(t *testing.T, response *httptest.ResponseRecorder, status int, code, category, message string, retryable bool) map[string]any {
	t.Helper()
	body := commonErrorBody(t, response)
	if response.Code != status || body["code"] != code || body["category"] != category || body["message"] != message || body["retryable"] != retryable {
		t.Fatalf("envelope=%v status=%d want code=%s category=%s message=%q retryable=%v status=%d",
			body, response.Code, code, category, message, retryable, status)
	}
	requestID, _ := body["request_id"].(string)
	if !rpcSafeID.MatchString(requestID) || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", body["request_id"], response.Header().Get("X-Request-ID"))
	}
	if response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "private-canary") {
		t.Fatalf("unsafe failure: headers=%v body=%s", response.Header(), response.Body.String())
	}
	return body
}

func TestCommonErrorWriteError(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		status     int
		code       string
		category   string
		message    string
		retryable  bool
		retryAfter string
	}{
		{"invalid-argument", domain.ErrInvalidArgument, 400, "invalid_argument", "invalid_request", "The request contains an invalid argument", false, ""},
		{"unauthenticated", domain.ErrUnauthenticated, 401, "unauthenticated", "unauthenticated", "Authentication failed", false, ""},
		{"forbidden", domain.ErrForbidden, 403, "forbidden", "forbidden", "The principal is not allowed to perform this operation", false, ""},
		{"not-found", domain.ErrNotFound, 404, "not_found", "not_found", "The requested identity resource does not exist", false, ""},
		{"conflict", domain.ErrConflict, 409, "conflict", "conflict", "The identity resource conflicts with an existing resource", false, ""},
		{"version-conflict", domain.ErrVersionConflict, 409, "version_conflict", "conflict", "The identity resource changed concurrently", true, ""},
		{"credential-busy", domain.ErrCredentialBusy, 503, "credential_busy", "unavailable", "Password verification is busy", true, "1"},
		{"credential-rate-limited", domain.ErrCredentialRateLimited, 429, "credential_rate_limited", "rate_limited", "Too many password attempts", true, "1"},
		{"oidc-session-expired", domain.NewError("oidc_session_expired", "Your OIDC session expired", false), 410, "oidc_session_expired", "not_found", "Your OIDC session expired", false, ""},
		{"private-error", errors.New("private-canary"), 500, "internal_error", "internal", "Identity Service could not complete the request", true, ""},
		{"ghost-code", domain.NewError("ghost_code", "private-canary", true), 500, "internal", "internal", "Internal service error", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, tc.err)
			assertCommonError(t, response, tc.status, tc.code, tc.category, tc.message, tc.retryable)
			if response.Header().Get("Retry-After") != tc.retryAfter {
				t.Fatalf("Retry-After=%q want %q", response.Header().Get("Retry-After"), tc.retryAfter)
			}
		})
	}
}

func TestCommonErrorWriteErrorRequestID(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "request-42.safe")
	writeError(response, domain.ErrNotFound)
	if body := commonErrorBody(t, response); body["request_id"] != "request-42.safe" {
		t.Fatalf("safe request id was not preserved: %v", body)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "bad id with spaces")
	writeError(response, domain.ErrNotFound)
	body := commonErrorBody(t, response)
	if body["request_id"] == "bad id with spaces" || body["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("unsafe request id was not replaced: %v", body)
	}
}

func TestCommonErrorRoute(t *testing.T) {
	services := &rpcServicesStub{resolveErr: domain.ErrUnauthenticated}
	handler := newRPCHandler(t, services)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes["resolve_access_token"], strings.NewReader(`{"access_token":"ant_api_contract","profile":"console"}`)))
	assertCommonError(t, response, http.StatusUnauthorized, "unauthenticated", "unauthenticated", "Authentication failed", false)
}
