package scim

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
)

var scimSafeID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func scimErrorBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("SCIM error body is not an object: %v", err)
	}
	return body
}

func assertSCIMCommonError(t *testing.T, response *httptest.ResponseRecorder, status int, code, category string, retryable bool) map[string]any {
	t.Helper()
	body := scimErrorBody(t, response)
	if response.Code != status {
		t.Fatalf("status=%d want=%d body=%s", response.Code, status, response.Body.String())
	}
	extension, _ := body["urn:antnest:error"].(map[string]any)
	if extension == nil {
		t.Fatalf("common extension missing: %v", body)
	}
	if extension["code"] != code || extension["category"] != category || extension["retryable"] != retryable {
		t.Fatalf("extension=%v want code=%s category=%s retryable=%v", extension, code, category, retryable)
	}
	requestID, _ := extension["request_id"].(string)
	if !scimSafeID.MatchString(requestID) || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", extension["request_id"], response.Header().Get("X-Request-ID"))
	}
	return body
}

func TestCommonErrorSCIMShape(t *testing.T) {
	response := httptest.NewRecorder()
	writeSCIMError(response, http.StatusBadRequest, "invalidValue", "The supplied value is invalid")
	body := assertSCIMCommonError(t, response, http.StatusBadRequest, "invalid_request", "invalid_request", false)
	if body["status"] != "400" || body["detail"] != "The supplied value is invalid" || body["scimType"] != "invalidValue" {
		t.Fatalf("SCIM shape changed: %v", body)
	}
	schemas, _ := body["schemas"].([]any)
	if len(schemas) != 1 || schemas[0] != errorSchema {
		t.Fatalf("schemas=%v want [%s]", schemas, errorSchema)
	}
	if response.Header().Get("Content-Type") != "application/scim+json" {
		t.Fatalf("Content-Type=%q", response.Header().Get("Content-Type"))
	}
}

func TestCommonErrorSCIMCanonicalMapping(t *testing.T) {
	for _, row := range []struct {
		status    int
		code      string
		retryable bool
	}{
		{401, "unauthenticated", false}, {403, "forbidden", false}, {404, "not_found", false},
		{409, "conflict", false}, {412, "precondition_failed", false},
		{429, "rate_limited", true}, {503, "unavailable", true}, {500, "internal", false},
	} {
		response := httptest.NewRecorder()
		writeSCIMError(response, row.status, "", "Failure")
		assertSCIMCommonError(t, response, row.status, row.code, row.code, row.retryable)
	}
}
