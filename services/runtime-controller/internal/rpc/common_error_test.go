package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/apierror"
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
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

var commonErrorSafeID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func assertCommonError(t *testing.T, response *httptest.ResponseRecorder, status int, code, category, message string, retryable bool) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("failure body is not an object: %v", err)
	}
	if response.Code != status || body["code"] != code || body["category"] != category ||
		body["message"] != message || body["retryable"] != retryable {
		t.Fatalf("envelope=%v status=%d want code=%s category=%s message=%q retryable=%v status=%d",
			body, response.Code, code, category, message, retryable, status)
	}
	requestID, _ := body["request_id"].(string)
	if !commonErrorSafeID.MatchString(requestID) || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("request_id=%v header=%q", body["request_id"], response.Header().Get("X-Request-ID"))
	}
	if response.Header().Get("Cache-Control") != "no-store" ||
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
		{"invalid-request", control.ErrInvalidRequest, 400, "invalid_request", "invalid_request", "request is invalid", false},
		{"mutation-in-progress", control.ErrAgentMutationInProgress, 409, "agent_mutation_in_progress", "conflict", "another Agent mutation is still in progress", true},
		{"revision-conflict", control.ErrRevisionConflict, 409, "runtime_revision_conflict", "conflict", "Runtime revision is stale", false},
		{"skill-preflight", control.ErrSkillPreflightUnavailable, 503, "skill_preflight_unavailable", "unavailable", "prepared Skill volume inspection is unavailable", true},
		{"deadline", context.DeadlineExceeded, 504, "deadline_exceeded", "unavailable", "operation deadline exceeded", true},
		{"private-error", errors.New("private-canary"), 500, "internal_error", "internal", "internal service error", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, tc.err)
			assertCommonError(t, response, tc.status, tc.code, tc.category, tc.message, tc.retryable)
		})
	}
}

func TestCommonErrorWriteErrorCursorExpired(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, &control.ObservationCursorExpiredError{ResetSequence: 9})
	body := assertCommonError(t, response, http.StatusGone, "observation_cursor_expired", "not_found", "observation cursor is outside the retained journal", false)
	if seq, _ := body["reset_sequence"].(float64); uint64(seq) != 9 {
		t.Fatalf("reset_sequence lost: %v", body)
	}
	details, _ := body["details"].(map[string]any)
	if seq, _ := details["reset_sequence"].(float64); uint64(seq) != 9 {
		t.Fatalf("details.reset_sequence missing: %v", body)
	}
}

func TestCommonErrorWriteOperationError(t *testing.T) {
	response := httptest.NewRecorder()
	writeOperationError(response, deployment.Operation{ErrorCode: "runtime_not_ready"})
	assertCommonError(t, response, http.StatusInternalServerError, "runtime_not_ready", "internal", "Runtime did not become ready; check its startup configuration and required MCP processes", false)
	response = httptest.NewRecorder()
	writeOperationError(response, deployment.Operation{ErrorCode: "ghost_operation"})
	assertCommonError(t, response, http.StatusInternalServerError, "operation_failed", "internal", "deployment operation failed", false)
}

func TestCommonErrorAcpIncarnation(t *testing.T) {
	response := httptest.NewRecorder()
	writeAcpIncarnationError(response, "acp_registry_unavailable")
	assertCommonError(t, response, http.StatusServiceUnavailable, "acp_registry_unavailable", "unavailable", "ACP incarnation request did not complete", true)
	response = httptest.NewRecorder()
	writeAcpIncarnationError(response, "service_unauthenticated")
	assertCommonError(t, response, http.StatusUnauthorized, "service_unauthenticated", "unauthenticated", "ACP incarnation request did not complete", false)
}

func TestCommonErrorWriteJSONNormalizes(t *testing.T) {
	response := httptest.NewRecorder()
	writeJSON(response, http.StatusInternalServerError, errorResponse{Code: "ghost_code", Message: "private-canary", Retryable: true})
	assertCommonError(t, response, http.StatusInternalServerError, "internal", "internal", "Internal service error", false)
	response = httptest.NewRecorder()
	writeJSON(response, http.StatusBadRequest, &errorResponse{Code: "invalid_request", Message: "request is invalid", Retryable: false})
	assertCommonError(t, response, http.StatusBadRequest, "invalid_request", "invalid_request", "request is invalid", false)
}

func TestCommonErrorRequestID(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "request-42.safe")
	writeError(response, control.ErrInvalidRequest)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["request_id"] != "request-42.safe" {
		t.Fatalf("safe request id was not preserved: %v", body)
	}
	response = httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "bad id with spaces")
	writeError(response, control.ErrInvalidRequest)
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["request_id"] == "bad id with spaces" || body["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("unsafe request id was not replaced: %v", body)
	}
}

func TestCommonErrorRouteUnauthenticated(t *testing.T) {
	handler, err := NewHandler(&fakeService{}, observation.NewHub(), time.Second, time.Second, incarnationRPCSecurity(t), &preparationStub{})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtimes", nil))
	assertCommonError(t, response, http.StatusUnauthorized, "service_unauthenticated", "unauthenticated", "Verified Controller workload is required", false)
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
			switch expr := node.(type) {
			case *ast.CallExpr:
				if fun, ok := expr.Fun.(*ast.Ident); ok && fun.Name == "writeAcpIncarnationError" && len(expr.Args) > 1 {
					if lit, ok := expr.Args[1].(*ast.BasicLit); ok && lit.Kind == token.STRING {
						problems = append(problems, fmt.Sprintf("%s:%d writeAcpIncarnationError literal", path, fset.Position(lit.Pos()).Line))
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
	if err := os.WriteFile(fixture, []byte("package fixture\nfunc f() {\n\twriteAcpIncarnationError(nil, \"internal_error\")\n\t_ = errorResponse{Code: \"invalid_request\"}\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if problems := check(fixture); len(problems) != 2 {
		t.Fatalf("mutation fixture not rejected: %v", problems)
	}
}

func TestCommonErrorContractCodeParity(t *testing.T) {
	root := serviceRoot(t)
	var contract struct {
		Errors map[string]struct {
			Status int `json:"status"`
		} `json:"errors"`
	}
	readJSONFile(t, filepath.Join(root, "../../contracts/runtime-controller/control-contract.json"), &contract)
	for code := range contract.Errors {
		if got := apierror.New(code, "probe", "req-1").Code; got != code {
			t.Errorf("contract code %s falls back to %s", code, got)
		}
	}
}

func TestCommonErrorActualResponsesMatchContracts(t *testing.T) {
	root := serviceRoot(t)
	readFile := func(rel string) any {
		data, err := os.ReadFile(filepath.Join(root, "..", "..", rel))
		if err != nil {
			t.Fatal(err)
		}
		var doc any
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for id, rel := range map[string]string{
		"https://schemas.antnest.dev/common/error.schema.json":                "contracts/common/error.schema.json",
		"https://schemas.antnest.dev/agent-acp/owner-incarnation.schema.json": "contracts/agent-acp/owner-incarnation.schema.json",
	} {
		if err := compiler.AddResource(id, readFile(rel)); err != nil {
			t.Fatalf("load %s: %v", rel, err)
		}
	}
	schemaDoc, err := os.ReadFile(filepath.Join(root, "../../contracts/runtime-controller", "control-api.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rcSchema struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(schemaDoc, &rcSchema); err != nil {
		t.Fatal(err)
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaDoc))
	if err != nil {
		t.Fatal(err)
	}
	if err := compiler.AddResource(rcSchema.ID, value); err != nil {
		t.Fatal(err)
	}
	assertEmitted := func(def string, body []byte) {
		t.Helper()
		shape, err := compiler.Compile(rcSchema.ID + "#/$defs/" + def)
		if err != nil {
			t.Fatal(err)
		}
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err := shape.Validate(document); err != nil {
			t.Fatalf("%s output violates schema: %v\n%s", def, err, body)
		}
	}
	invalid := httptest.NewRecorder()
	writeError(invalid, control.ErrInvalidRequest)
	assertEmitted("error", invalid.Body.Bytes())
	cursor := httptest.NewRecorder()
	writeError(cursor, &control.ObservationCursorExpiredError{ResetSequence: 9})
	assertEmitted("error", cursor.Body.Bytes())
	registry := httptest.NewRecorder()
	writeAcpIncarnationError(registry, apierror.AcpRegistryUnavailable)
	assertEmitted("acp_incarnation_error", registry.Body.Bytes())
	shape, err := compiler.Compile(rcSchema.ID + "#/$defs/error")
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"missing category":  func(v map[string]any) { delete(v, "category") },
		"unsafe request_id": func(v map[string]any) { v["request_id"] = "bad id with spaces" },
	} {
		var mutated map[string]any
		if err := json.Unmarshal(invalid.Body.Bytes(), &mutated); err != nil {
			t.Fatal(err)
		}
		mutate(mutated)
		if err := shape.Validate(mutated); err == nil {
			t.Fatalf("mutated error body %q must violate the error schema", name)
		}
	}
	owner, err := compiler.Compile("https://schemas.antnest.dev/agent-acp/owner-incarnation.schema.json#/$defs/error")
	if err != nil {
		t.Fatal(err)
	}
	oldEnvelope := map[string]any{"code": "service_unauthenticated", "message": "denied", "retryable": false}
	if err := owner.Validate(oldEnvelope); err != nil {
		t.Fatalf("legacy owner envelope must remain valid: %v", err)
	}
	full := map[string]any{"code": "service_unauthenticated", "category": "unauthenticated", "message": "denied", "retryable": false, "request_id": "req-1"}
	if err := owner.Validate(full); err != nil {
		t.Fatalf("full common owner envelope must be valid: %v", err)
	}
	partial := map[string]any{"code": "service_unauthenticated", "category": "unauthenticated", "message": "denied", "retryable": false}
	if err := owner.Validate(partial); err == nil {
		t.Fatal("category without request_id must be rejected by dependentRequired")
	}
}
