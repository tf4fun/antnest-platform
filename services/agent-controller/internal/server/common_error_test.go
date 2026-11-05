package server

import (
	"context"
	"encoding/json"
	"fmt"
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

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var commonErrorSafeID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

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
	if response.Code != status || body["code"] != code || body["category"] != category ||
		body["message"] != message || body["retryable"] != retryable {
		t.Fatalf("envelope=%v status=%d want code=%s category=%s message=%q retryable=%v status=%d",
			body, response.Code, code, category, message, retryable, status)
	}
	requestID, _ := body["request_id"].(string)
	if !commonErrorSafeID.MatchString(requestID) || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", body["request_id"], response.Header().Get("X-Request-ID"))
	}
	if response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "private-canary") {
		t.Fatalf("unsafe failure: headers=%v body=%s", response.Header(), response.Body.String())
	}
	return body
}

func TestCommonErrorWriteError(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		code      string
		category  string
		message   string
		retryable bool
	}{
		{"invalid-request", 400, "invalid_request", "invalid_request", "request is invalid", false},
		{"service-unauthenticated", 401, "service_unauthenticated", "unauthenticated", "Service authentication rejected", false},
		{"forbidden", 403, "forbidden", "forbidden", "Access is denied", false},
		{"agent-not-found", 404, "agent_not_found", "not_found", "Agent was not found", false},
		{"version-conflict", 409, "resource_version_conflict", "conflict", "resource changed concurrently", false},
		{"dependency-unavailable", 503, "dependency_unavailable", "unavailable", "dependency is unavailable", true},
		{"internal-error", 500, "internal_error", "internal", "internal service error", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, tc.status, tc.code, tc.message, tc.retryable)
			assertCommonError(t, response, tc.status, tc.code, tc.category, tc.message, tc.retryable)
		})
	}
}

func TestCommonErrorWriteErrorRequestID(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "request-42.safe")
	writeError(response, http.StatusNotFound, "agent_not_found", "Agent was not found", false)
	if body := commonErrorBody(t, response); body["request_id"] != "request-42.safe" {
		t.Fatalf("safe request id was not preserved: %v", body)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "bad id with spaces")
	writeError(response, http.StatusNotFound, "agent_not_found", "Agent was not found", false)
	body := commonErrorBody(t, response)
	if body["request_id"] == "bad id with spaces" || body["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("unsafe request id was not replaced: %v", body)
	}
}

func TestCommonErrorWriteErrorUnknownCode(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, http.StatusInternalServerError, "ghost_code", "private-canary", true)
	assertCommonError(t, response, http.StatusInternalServerError, "internal", "internal", "Internal service error", false)
}

func TestCommonErrorWriteServiceError(t *testing.T) {
	response := httptest.NewRecorder()
	writeServiceError(context.Background(), response, application.ErrAgentNotReady)
	assertCommonError(t, response, http.StatusConflict, "agent_not_ready", "conflict", "Agent is not ready", true)

	response = httptest.NewRecorder()
	writeServiceError(context.Background(), response, context.DeadlineExceeded)
	assertCommonError(t, response, http.StatusGatewayTimeout, "lifecycle_timeout", "unavailable", "lifecycle operation timed out", true)
}

func TestCommonErrorWriteServiceErrorReferences(t *testing.T) {
	response := httptest.NewRecorder()
	writeServiceError(context.Background(), response, &ports.CatalogReferenceConflict{
		References: []ports.CatalogReference{{Kind: "template", ResourceID: "template-1"}, {Kind: "agent", ResourceID: "agent-1", AgentID: "agent-1"}},
		Truncated:  true,
	})
	body := assertCommonError(t, response, http.StatusConflict, "resource_in_use", "conflict",
		"remove current catalog references before disabling this resource", false)
	references, _ := body["references"].([]any)
	if len(references) != 2 || references[0].(map[string]any)["resource_id"] != "template-1" {
		t.Fatalf("references not preserved: %v", body)
	}
	if body["references_truncated"] != true {
		t.Fatalf("references_truncated not preserved: %v", body)
	}
	details, _ := body["details"].(map[string]any)
	detailRefs, _ := details["references"].([]any)
	if len(detailRefs) != 2 || details["references_truncated"] != true {
		t.Fatalf("references not duplicated under details: %v", body)
	}
}

func TestCommonErrorWriteJSONNormalizesErrorResponse(t *testing.T) {
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusConflict, errorResponse{Code: "resource_version_conflict", Message: "resource changed concurrently", Retryable: false})
	assertCommonError(t, response, http.StatusConflict, "resource_version_conflict", "conflict", "resource changed concurrently", false)
}

func TestCommonErrorWriteJSONMarshalFallback(t *testing.T) {
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusOK, make(chan int))
	body := assertCommonError(t, response, http.StatusInternalServerError, "internal", "internal", "Internal service error", false)
	if !strings.HasPrefix(strings.TrimSpace(response.Body.String()), "{") || body["code"] == "" {
		t.Fatalf("fallback is not a common envelope: %s", response.Body.String())
	}
}

func TestErrorCodeLiteralsForbidden(t *testing.T) {
	check := func(path string) []string {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		var problems []string
		ast.Inspect(file, func(node ast.Node) bool {
			switch expr := node.(type) {
			case *ast.CallExpr:
				if fun, ok := expr.Fun.(*ast.Ident); ok && fun.Name == "writeError" && len(expr.Args) >= 3 {
					if lit, ok := expr.Args[2].(*ast.BasicLit); ok && lit.Kind == token.STRING {
						problems = append(problems, fmt.Sprintf("%s:%d writeError literal code", path, fset.Position(lit.Pos()).Line))
					}
				}
			case *ast.CompositeLit:
				if typ, ok := expr.Type.(*ast.Ident); ok && typ.Name == "errorResponse" {
					for _, element := range expr.Elts {
						if field, ok := element.(*ast.KeyValueExpr); ok {
							if key, ok := field.Key.(*ast.Ident); ok && key.Name == "Code" {
								if lit, ok := field.Value.(*ast.BasicLit); ok && lit.Kind == token.STRING {
									problems = append(problems, fmt.Sprintf("%s:%d errorResponse literal code", path, fset.Position(lit.Pos()).Line))
								}
							}
						}
					}
				}
			}
			return true
		})
		return problems
	}
	entries, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range entries {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		if problems := check(path); len(problems) != 0 {
			t.Fatalf("literal error codes remain: %v", problems)
		}
	}
	fixture := filepath.Join(t.TempDir(), "fixture.go")
	if err := os.WriteFile(fixture, []byte("package fixture\nfunc f() {\n\twriteError(nil, 0, \"agent_not_found\", \"x\", false)\n\t_ = errorResponse{Code: \"forbidden\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if problems := check(fixture); len(problems) != 2 {
		t.Fatalf("mutation fixture not rejected: %v", problems)
	}
}

func TestCommonErrorContractCodeParity(t *testing.T) {
	var contract struct {
		Errors struct {
			StatusByCode map[string]int `json:"status_by_code"`
		} `json:"errors"`
	}
	readContractJSON(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-contract.json"), &contract)
	for code := range contract.Errors.StatusByCode {
		if got := apierror.New(code, "probe", "req-1").Code; got != code {
			t.Errorf("contract code %s falls back to %s", code, got)
		}
	}
}

func TestCommonErrorWriteJSONPointer(t *testing.T) {
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusConflict, &errorResponse{Code: "resource_version_conflict", Message: "resource changed concurrently", Retryable: false})
	assertCommonError(t, response, http.StatusConflict, "resource_version_conflict", "conflict", "resource changed concurrently", false)
}

func TestCommonErrorWriteJSONUnknownClearsExtensions(t *testing.T) {
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusInternalServerError, errorResponse{
		Code: "ghost_code", Message: "private-canary", Retryable: true,
		References:          []ports.CatalogReference{{Kind: "template", ResourceID: "private-canary"}},
		ReferencesTruncated: true,
		Details:             map[string]any{"private_canary": "private-canary"},
	})
	body := assertCommonError(t, response, http.StatusInternalServerError, "internal", "internal", "Internal service error", false)
	if _, exists := body["references"]; exists {
		t.Fatalf("upstream references were reflected: %v", body)
	}
	if _, exists := body["references_truncated"]; exists {
		t.Fatalf("references_truncated was reflected: %v", body)
	}
	if _, exists := body["details"]; exists {
		t.Fatalf("upstream details were reflected: %v", body)
	}
}
