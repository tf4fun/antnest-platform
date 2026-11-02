package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/apierror"
)

var commonRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func commonErrorBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("error response is not a JSON object: %v", err)
	}
	return body
}

func assertCommonError(t *testing.T, response *httptest.ResponseRecorder, status int, code, category string, retryable bool) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("%s status = %d, want %d", code, response.Code, status)
	}
	body := commonErrorBody(t, response)
	requestID, _ := body["request_id"].(string)
	if body["code"] != code || body["category"] != category || body["retryable"] != retryable ||
		requestID == "" || !commonRequestIDPattern.MatchString(requestID) ||
		requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("%s envelope = %v with X-Request-ID %q", code, body, response.Header().Get("X-Request-ID"))
	}
	message, _ := body["message"].(string)
	if message == "" || strings.Contains(message, "private") {
		t.Fatalf("%s message is empty or leaks a private detail: %q", code, message)
	}
	if len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("%s leaked a cookie header", code)
	}
}

func registryEntries(t *testing.T) map[string]struct {
	category   string
	retryable  bool
	httpStatus int
} {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Errors []struct {
			Code       string `json:"code"`
			Category   string `json:"category"`
			Retryable  bool   `json:"retryable"`
			HTTPStatus int    `json:"http_status"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &registry); err != nil {
		t.Fatal(err)
	}
	entries := map[string]struct {
		category   string
		retryable  bool
		httpStatus int
	}{}
	for _, entry := range registry.Errors {
		entries[entry.Code] = struct {
			category   string
			retryable  bool
			httpStatus int
		}{entry.Category, entry.Retryable, entry.HTTPStatus}
	}
	return entries
}

func TestCommonErrorEnvelopeAcrossBoundary(t *testing.T) {
	for _, row := range []struct {
		name      string
		status    int
		code      string
		category  string
		retryable bool
	}{
		{"missing-auth", http.StatusUnauthorized, apierror.Unauthenticated, "unauthenticated", false},
		{"denied", http.StatusForbidden, apierror.Forbidden, "forbidden", false},
		{"invalid", http.StatusBadRequest, apierror.InvalidRequest, "invalid_request", false},
		{"missing-route", http.StatusNotFound, apierror.NotFound, "not_found", false},
		{"saturated", http.StatusTooManyRequests, apierror.Busy, "rate_limited", true},
		{"dependency-outage", http.StatusServiceUnavailable, apierror.DependencyUnavailable, "unavailable", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, row.status, row.code, "Contract probe")
			assertCommonError(t, response, row.status, row.code, row.category, row.retryable)
			response = httptest.NewRecorder()
			writeFailure(response, row.status, row.code, "Contract probe", nil)
			assertCommonError(t, response, row.status, row.code, row.category, row.retryable)
		})
	}
}

func TestCommonErrorWriteErrorCoversSlice(t *testing.T) {
	sliceData, err := os.ReadFile("../../../../contracts/common/slices/admin-console.json")
	if err != nil {
		t.Fatal(err)
	}
	var slice struct {
		Codes []string `json:"codes"`
	}
	if err := json.Unmarshal(sliceData, &slice); err != nil {
		t.Fatal(err)
	}
	entries := registryEntries(t)
	for _, code := range slice.Codes {
		entry, ok := entries[code]
		if !ok {
			t.Fatalf("slice code %s is not registered", code)
		}
		response := httptest.NewRecorder()
		writeError(response, entry.httpStatus, code, "Contract probe")
		assertCommonError(t, response, entry.httpStatus, code, entry.category, entry.retryable)
	}
}

func TestCommonErrorWriteErrorRequestIDHandling(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "console-req-9.safe_1:x")
	writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "Bad")
	if got := commonErrorBody(t, response)["request_id"]; got != "console-req-9.safe_1:x" {
		t.Fatalf("safe response request id was replaced: %v", got)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "forged unsafe id!!")
	writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "Bad")
	body := commonErrorBody(t, response)
	id := response.Header().Get("X-Request-ID")
	if id == "forged unsafe id!!" || body["request_id"] != id {
		t.Fatalf("unsafe response request id survived: %q body %v", id, body)
	}
	first, second := httptest.NewRecorder(), httptest.NewRecorder()
	writeError(first, http.StatusInternalServerError, apierror.Internal, "boom")
	writeError(second, http.StatusInternalServerError, apierror.Internal, "boom")
	if first.Header().Get("X-Request-ID") == "" ||
		first.Header().Get("X-Request-ID") == second.Header().Get("X-Request-ID") {
		t.Fatal("request ids were not freshly generated per call")
	}
}

func TestCommonErrorWriteErrorUnknownCodeSanitizes(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, http.StatusInternalServerError, "ghost_code", "private-token-canary")
	body := commonErrorBody(t, response)
	if body["code"] != apierror.Internal || body["category"] != "internal" ||
		body["message"] != "Internal service error" || body["retryable"] != false {
		t.Fatalf("unknown code leaked its message: %v", body)
	}
}

func TestCommonErrorUpstreamProjection(t *testing.T) {
	for _, row := range []struct {
		name       string
		status     int
		payload    string
		wantStatus int
		code       string
		category   string
		retryable  bool
	}{
		{"flat-known", http.StatusForbidden, `{"code":"forbidden","message":"denied"}`, http.StatusForbidden, apierror.Forbidden, "forbidden", false},
		{"nested-legacy", http.StatusNotFound, `{"error":{"code":"not_found","message":"gone"}}`, http.StatusNotFound, apierror.NotFound, "not_found", false},
		{"upstream-retry-ignored", http.StatusForbidden, `{"code":"forbidden","message":"denied","retryable":true}`, http.StatusForbidden, apierror.Forbidden, "forbidden", false},
		{"unknown-code", http.StatusInternalServerError, `{"code":"ghost_code","message":"private-token-canary"}`, http.StatusBadGateway, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"malformed", http.StatusServiceUnavailable, `not-json`, http.StatusBadGateway, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"non-object", http.StatusServiceUnavailable, `[1,2]`, http.StatusBadGateway, apierror.InvalidUpstreamResponse, "unavailable", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeRaw(response, row.status, http.Header{}, []byte(row.payload))
			assertCommonError(t, response, row.wantStatus, row.code, row.category, row.retryable)
			if strings.Contains(response.Body.String(), "private-token-canary") {
				t.Fatalf("%s leaked an upstream detail", row.name)
			}
		})
	}
}

func TestCommonErrorUpstreamProjectionPreservesReferences(t *testing.T) {
	response := httptest.NewRecorder()
	writeRaw(response, http.StatusNotFound, http.Header{}, []byte(`{"code":"not_found","message":"gone","references":[{"id":"a"}],"references_truncated":true}`))
	body := commonErrorBody(t, response)
	if body["code"] != apierror.NotFound || body["references_truncated"] != true {
		t.Fatalf("references were dropped: %v", body)
	}
	references, _ := body["references"].([]any)
	if len(references) != 1 || references[0].(map[string]any)["id"] != "a" {
		t.Fatalf("references not preserved: %v", body)
	}
	details, _ := body["details"].(map[string]any)
	if details == nil || details["references_truncated"] != true {
		t.Fatalf("references not projected into details: %v", body)
	}
}

func TestCommonErrorUpstreamProjectionKeepsSuccess(t *testing.T) {
	response := httptest.NewRecorder()
	header := http.Header{"Etag": {"v1"}, "Content-Type": {"application/octet-stream"}}
	writeRaw(response, http.StatusOK, header, []byte("raw-bytes"))
	if response.Code != http.StatusOK || response.Body.String() != "raw-bytes" ||
		response.Header().Get("ETag") != "v1" {
		t.Fatalf("success passthrough changed: %d %q %v", response.Code, response.Body.String(), response.Header())
	}
}

func literalErrorCodeArguments(t *testing.T, name, source string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, source, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	var problems []string
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		function, ok := call.Fun.(*ast.Ident)
		if !ok || (function.Name != "writeError" && function.Name != "writeFailure") || len(call.Args) < 3 {
			return true
		}
		if literal, ok := call.Args[2].(*ast.BasicLit); ok {
			problems = append(problems, name+": "+function.Name+" "+literal.Value)
		}
		return true
	})
	return problems
}

func TestErrorCodeLiteralArgumentsAreGeneratedConstants(t *testing.T) {
	var problems []string
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		source, err := os.ReadFile(filepath.Join(".", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		problems = append(problems, literalErrorCodeArguments(t, entry.Name(), string(source))...)
	}
	if len(problems) != 0 {
		t.Fatalf("error code arguments must be generated constants: %v", problems)
	}
	mutation := literalErrorCodeArguments(t, "mutation.go", `package server
func probe(response http.ResponseWriter) {
	writeError(response, 500, "internal", "boom")
	writeFailure(response, 500, "internal", "boom", nil)
}
`)
	if len(mutation) != 2 {
		t.Fatalf("the literal code check accepted a mutation: %v", mutation)
	}
}

func TestCommonErrorUpstreamMetadata(t *testing.T) {
	for _, row := range []struct {
		name      string
		upstream  int
		payload   string
		want      int
		code      string
		category  string
		retryable bool
	}{
		{"flat-n", 404, `{"code":"not_found","message":"gone","category":"not_found","retryable":false,"request_id":"upstream-1","details":{"private_canary":"x"}}`, 404, apierror.NotFound, "not_found", false},
		{"nested-n", 404, `{"error":{"code":"not_found","message":"gone","category":"not_found","retryable":false,"request_id":"upstream-1","details":{"private_canary":"x"}}}`, 404, apierror.NotFound, "not_found", false},
		{"alias-n", 500, `{"code":"internal_error","message":"down","category":"internal","request_id":"r1"}`, 500, apierror.InternalError, "internal", false},
		{"both-match", 404, `{"code":"not_found","message":"gone","error":{"code":"not_found","message":"gone"}}`, 404, apierror.NotFound, "not_found", false},
		{"both-diverge", 404, `{"code":"not_found","message":"gone","error":{"code":"forbidden","message":"gone"}}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"alias-divergence", 500, `{"code":"internal_error","message":"x","error":{"code":"internal","message":"x"}}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"nested-in-nested", 404, `{"error":{"error":{"code":"not_found","message":"gone"}}}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"details-only", 404, `{"code":"not_found","message":"gone","details":{"a":1}}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"category-only", 404, `{"code":"not_found","message":"gone","category":"not_found"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"id-only", 404, `{"code":"not_found","message":"gone","request_id":"r1"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"null-category", 404, `{"code":"not_found","message":"gone","category":null,"request_id":"r1"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"null-id", 404, `{"code":"not_found","message":"gone","category":"not_found","request_id":null}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"null-details", 404, `{"code":"not_found","message":"gone","category":"not_found","request_id":"r1","details":null}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"wrong-category", 404, `{"code":"not_found","message":"gone","category":"forbidden","request_id":"r1"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"unsafe-id", 404, `{"code":"not_found","message":"gone","category":"not_found","request_id":"bad id!!"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"empty-message", 404, `{"code":"not_found","message":""}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"empty-code", 404, `{"code":"","message":"gone"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"references-wrong-type", 404, `{"code":"not_found","message":"gone","references":"x"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"references-null", 404, `{"code":"not_found","message":"gone","references":null}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"truncated-null", 404, `{"code":"not_found","message":"gone","references_truncated":null}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
		{"truncated-string", 404, `{"code":"not_found","message":"gone","references_truncated":"yes"}`, 502, apierror.InvalidUpstreamResponse, "unavailable", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeRaw(response, row.upstream, http.Header{}, []byte(row.payload))
			assertCommonError(t, response, row.want, row.code, row.category, row.retryable)
			body := commonErrorBody(t, response)
			if strings.Contains(response.Body.String(), "private_canary") || body["request_id"] == "upstream-1" {
				t.Fatal("upstream private detail or request id was reflected")
			}
		})
	}
}

func TestCommonErrorUpstreamProjectionPreservesDetailsReferences(t *testing.T) {
	response := httptest.NewRecorder()
	writeRaw(response, http.StatusNotFound, http.Header{}, []byte(`{"code":"not_found","message":"gone","category":"not_found","request_id":"r1","details":{"references":[{"id":"a"}],"references_truncated":true}}`))
	body := commonErrorBody(t, response)
	if body["code"] != apierror.NotFound || body["references_truncated"] != true {
		t.Fatalf("references were dropped: %v", body)
	}
	references, _ := body["references"].([]any)
	if len(references) != 1 || references[0].(map[string]any)["id"] != "a" {
		t.Fatalf("references not preserved: %v", body)
	}
	details, _ := body["details"].(map[string]any)
	if details == nil || details["references_truncated"] != true || len(details) != 2 {
		t.Fatalf("references not projected into details: %v", body)
	}
	if body["request_id"] == "r1" {
		t.Fatal("upstream request_id was reflected")
	}
}

func TestErrorCodeConsumerParity(t *testing.T) {
	consumed := []string{
		"invalid_request", "unauthenticated", "forbidden", "not_found", "internal", "conflict",
		"internal_error", "resource_version_conflict", "request_conflict", "revision_conflict",
		"method_not_allowed", "principal_changed", "identity_unavailable", "invalid_current_password",
		"credential_busy", "credential_rate_limited", "invalid_idempotency_key", "runtime_image_required",
		"invalid_argument", "bad_request", "unsupported_media_type", "limit_exceeded",
		"encoding_failed", "streaming_unavailable", "upstream_error", "upstream_rejected",
		"invalid_upstream_response", "dependency_invalid_response", "provider_discovery_failed",
		"dependency_unavailable", "service_stopping", "application_unavailable",
		"agent_inventory_unavailable", "identity_dependency_unavailable", "provider_endpoint_unavailable",
		"cleanup_failed", "busy", "caller_context_required", "caller_context_invalid",
		"service_unauthenticated", "caller_not_allowed", "organization_mismatch", "actor_mismatch",
		"access_denied", "provider_endpoint_forbidden", "reference_not_found", "agent_not_found",
		"agent_network_not_found", "policy_revision_not_found", "revision_not_found",
		"model_profile_not_found", "template_not_found", "operation_not_found",
		"reference_disabled", "agent_network_unavailable", "policy_revision_conflict",
		"idempotency_conflict", "unavailable", "external_identity_last_method",
		"preparation_not_found", "audit_not_found", "resource_in_use", "request_id_conflict",
		"lifecycle_conflict", "execution_configuration_capacity_exceeded",
		"external_identity_conflict", "external_identity_restore_required",
		"invalid_model_spec", "invalid_cursor", "execution_audit_unavailable",
		"invalid_package", "name_conflict", "content_changed",
		"source_invalid", "temporarily_unavailable", "source_unavailable",
	}
	for code := range modelCallPolicyFailureStatus {
		consumed = append(consumed, code)
	}
	for code := range discoveryFailures {
		consumed = append(consumed, code)
	}
	for code := range createUserLegacyFailures {
		consumed = append(consumed, code)
	}
	seen := map[string]bool{}
	for _, code := range consumed {
		if seen[code] {
			continue
		}
		seen[code] = true
		if got := apierror.New(code, "probe", "req-1").Code; got != code {
			t.Errorf("consumed code %s falls back to %s", code, got)
		}
	}
}
