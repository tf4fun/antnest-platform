package registry

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/apierror"
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
	for _, level := range []string{"top", "error"} {
		got := body
		if level == "error" {
			nested, _ := body["error"].(map[string]any)
			if nested == nil {
				t.Fatalf("nested error object missing: %v", body)
			}
			got = nested
		}
		if response.Code != status || got["code"] != code || got["category"] != category ||
			got["message"] != message || got["retryable"] != retryable {
			t.Fatalf("%s envelope=%v status=%d want code=%s category=%s message=%q retryable=%v status=%d",
				level, got, response.Code, code, category, message, retryable, status)
		}
		requestID, _ := got["request_id"].(string)
		if !commonErrorSafeID.MatchString(requestID) || requestID != response.Header().Get("X-Request-ID") {
			t.Fatalf("%s request_id=%v header=%q", level, got["request_id"], response.Header().Get("X-Request-ID"))
		}
	}
	if response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" ||
		strings.Contains(response.Body.String(), "private-canary") {
		t.Fatalf("unsafe failure: headers=%v body=%s", response.Header(), response.Body.String())
	}
	return body
}

func TestCommonErrorWriteError(t *testing.T) {
	for _, tc := range []struct {
		name      string
		err       error
		status    int
		code      string
		category  string
		message   string
		retryable bool
	}{
		{"invalid-request", failure("invalid_request", "Request is invalid"), 400, "invalid_request", "invalid_request", "Request is invalid", false},
		{"invalid-package", failure("invalid_package", "Package is invalid"), 400, "invalid_package", "invalid_request", "Package is invalid", false},
		{"not-found", failure("not_found", "Skill was not found"), 404, "not_found", "not_found", "Skill was not found", false},
		{"revision-conflict", failure("revision_conflict", "Version changed"), 409, "revision_conflict", "conflict", "Version changed", false},
		{"request-conflict", failure("request_conflict", "Request already exists"), 409, "request_conflict", "conflict", "Request already exists", false},
		{"limit-exceeded", failure("limit_exceeded", "Package is too large"), 413, "limit_exceeded", "invalid_request", "Package is too large", false},
		{"busy", failure("busy", "Registry is busy"), 429, "busy", "rate_limited", "Registry is busy", true},
		{"source-invalid", failure("source_invalid", "Source is invalid"), 502, "source_invalid", "unavailable", "Source is invalid", true},
		{"source-unavailable", failure("source_unavailable", "Source is unavailable"), 503, "source_unavailable", "unavailable", "Source is unavailable", true},
		{"private-error", errors.New("private-canary"), 503, "temporarily_unavailable", "unavailable", "Registry temporarily unavailable", true},
		{"ghost-code", failure("ghost_code", "private-canary"), 503, "internal", "internal", "Internal service error", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, tc.err)
			assertCommonError(t, response, tc.status, tc.code, tc.category, tc.message, tc.retryable)
		})
	}
}

func TestCommonErrorWriteBoundaryError(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		code      string
		category  string
		message   string
		retryable bool
	}{
		{"caller-context-required", 401, "caller_context_required", "unauthenticated", "Caller context is required", false},
		{"forbidden", 403, "forbidden", "forbidden", "Access is denied", false},
		{"identity-dependency", 503, "identity_dependency_unavailable", "unavailable", "Identity verification is unavailable", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeBoundaryError(response, tc.status, tc.code, tc.message, tc.retryable)
			assertCommonError(t, response, tc.status, tc.code, tc.category, tc.message, tc.retryable)
		})
	}
}

func TestCommonErrorRequestIDPreservation(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "request-42.safe")
	writeBoundaryError(response, http.StatusForbidden, "forbidden", "Access is denied", false)
	if body := commonErrorBody(t, response); body["request_id"] != "request-42.safe" {
		t.Fatalf("safe request id was not preserved: %v", body)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "bad id with spaces")
	writeBoundaryError(response, http.StatusForbidden, "forbidden", "Access is denied", false)
	body := commonErrorBody(t, response)
	if body["request_id"] == "bad id with spaces" || body["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("unsafe request id was not replaced: %v", body)
	}
}

func TestCommonErrorRoute(t *testing.T) {
	handler := newTestHandler(t, NewService(&memoryStore{}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/skills", nil))
	assertCommonError(t, response, http.StatusUnauthorized, "service_unauthenticated", "unauthenticated", "Service authentication failed", false)
	if response.Header().Get("WWW-Authenticate") == "" {
		t.Fatal("authentication challenge was lost")
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
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			fun, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			var argIndex = -1
			if fun.Name == "failure" && len(call.Args) > 0 {
				argIndex = 0
			}
			if fun.Name == "writeBoundaryError" && len(call.Args) > 2 {
				argIndex = 2
			}
			if argIndex >= 0 {
				if lit, ok := call.Args[argIndex].(*ast.BasicLit); ok && lit.Kind == token.STRING {
					problems = append(problems, fmt.Sprintf("%s:%d %s literal code", path, fset.Position(lit.Pos()).Line, fun.Name))
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
	if err := os.WriteFile(fixture, []byte("package fixture\nfunc f() {\n\t_ = failure(\"busy\", \"x\")\n\twriteBoundaryError(nil, 0, \"forbidden\", \"x\", false)\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if problems := check(fixture); len(problems) != 2 {
		t.Fatalf("mutation fixture not rejected: %v", problems)
	}
}

func TestCommonErrorSliceParity(t *testing.T) {
	var slice struct {
		Codes []string `json:"codes"`
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "common", "slices", "skill-registry.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &slice); err != nil {
		t.Fatal(err)
	}
	for _, code := range slice.Codes {
		if got := apierror.New(code, "probe", "req-1").Code; got != code {
			t.Errorf("slice code %s falls back to %s", code, got)
		}
	}
}
