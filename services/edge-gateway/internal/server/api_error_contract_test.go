package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/apierror"
)

func compileCommonErrorSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/error.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	const id = "https://antnest.test/common-error.schema.json"
	compiler := jsonschema.NewCompiler()
	compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
		compiled, err := regexp2.Compile(pattern, regexp2.ECMAScript)
		if err != nil {
			return nil, err
		}
		compiled.MatchTimeout = 100 * time.Millisecond
		return contractRegexp{compiled}, nil
	})
	if err := compiler.AddResource(id, document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(id)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func commonErrorBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("error response is not a JSON object: %v", err)
	}
	return body
}

func assertCommonError(t *testing.T, schema *jsonschema.Schema, response *httptest.ResponseRecorder, status int, code, category string, retryable bool) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("%s status = %d, want %d", code, response.Code, status)
	}
	body := commonErrorBody(t, response)
	if err := schema.Validate(body); err != nil {
		t.Fatalf("%s envelope failed the common error schema: %v", code, err)
	}
	requestID, _ := body["request_id"].(string)
	if body["code"] != code || body["category"] != category || body["retryable"] != retryable ||
		requestID == "" || requestID != response.Header().Get("X-Request-ID") {
		t.Fatalf("%s envelope = %v with X-Request-ID %q", code, body, response.Header().Get("X-Request-ID"))
	}
	message, _ := body["message"].(string)
	if message == "" || strings.Contains(message, "private") {
		t.Fatalf("%s message is empty or leaks a private detail: %q", code, message)
	}
}

func TestCommonErrorEnvelopeAcrossRoutes(t *testing.T) {
	schema := compileCommonErrorSchema(t)
	login := `{"organization_slug":"engineering","email":"member@example.com","password":"private-password-canary"}`
	for _, row := range []struct {
		name      string
		exercise  func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder
		status    int
		code      string
		category  string
		retryable bool
	}{
		{"invalid-login", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			response := httptest.NewRecorder()
			request := newBrowserRequest(http.MethodPost, "/api/session/login", strings.NewReader(`{}`))
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(response, request)
			return response
		}, http.StatusBadRequest, apierror.InvalidRequest, "invalid_request", false},
		{"missing-cookie", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, newBrowserRequest(http.MethodGet, "/api/session", nil))
			return response
		}, http.StatusUnauthorized, apierror.Unauthenticated, "unauthenticated", false},
		{"bad-origin", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			response := httptest.NewRecorder()
			request := newBrowserRequest(http.MethodPost, "/api/session/login", strings.NewReader(login))
			request.Header.Set("Origin", "https://forged.example")
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(response, request)
			return response
		}, http.StatusForbidden, apierror.Forbidden, "forbidden", false},
		{"missing-route", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, newBrowserRequest(http.MethodGet, "/api/missing", nil))
			return response
		}, http.StatusNotFound, apierror.NotFound, "not_found", false},
		{"login-admission", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			var response *httptest.ResponseRecorder
			for attempt := 0; attempt < 12; attempt++ {
				response = httptest.NewRecorder()
				request := newBrowserRequest(http.MethodPost, "/api/session/login", strings.NewReader(login))
				request.Header.Set("Content-Type", "application/json")
				handler.ServeHTTP(response, request)
			}
			return response
		}, http.StatusTooManyRequests, apierror.LoginRateLimited, "rate_limited", true},
		{"identity-outage", func(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
			response := httptest.NewRecorder()
			request := newBrowserRequest(http.MethodGet, "/api/session", nil)
			addSessionCookies(request, "old-private-token", testCSRFToken)
			handler.ServeHTTP(response, request)
			return response
		}, http.StatusServiceUnavailable, apierror.IdentityUnavailable, "unavailable", true},
	} {
		t.Run(row.name, func(t *testing.T) {
			handler := newTestHandler(t, &identityServiceStub{resolveErr: errors.New("down")}, http.NotFoundHandler(), time.Now())
			response := row.exercise(t, handler)
			assertCommonError(t, schema, response, row.status, row.code, row.category, row.retryable)
			if strings.Contains(response.Body.String(), "old-private-token") || len(response.Header().Values("Set-Cookie")) != 0 && row.name != "missing-cookie" {
				t.Fatalf("%s leaked a cookie or credential", row.name)
			}
		})
	}
}

func TestCommonErrorWriteErrorCoversSlice(t *testing.T) {
	schema := compileCommonErrorSchema(t)
	sliceData, err := os.ReadFile("../../../../contracts/common/slices/edge-gateway.json")
	if err != nil {
		t.Fatal(err)
	}
	registryData, err := os.ReadFile("../../../../contracts/common/errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var slice struct {
		Codes []string `json:"codes"`
	}
	var registry struct {
		Errors []struct {
			Code       string `json:"code"`
			Category   string `json:"category"`
			Retryable  bool   `json:"retryable"`
			HTTPStatus int    `json:"http_status"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(sliceData, &slice); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(registryData, &registry); err != nil {
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
	for _, code := range slice.Codes {
		entry, ok := entries[code]
		if !ok {
			t.Fatalf("slice code %s is not registered", code)
		}
		response := httptest.NewRecorder()
		writeError(response, entry.httpStatus, code, "Contract probe")
		assertCommonError(t, schema, response, entry.httpStatus, code, entry.category, entry.retryable)
	}
}

func TestCommonErrorWriteErrorRequestIDHandling(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("X-Request-ID", "edge-req-9.safe_1:x")
	writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "Bad")
	if got := commonErrorBody(t, response)["request_id"]; got != "edge-req-9.safe_1:x" {
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
	writeError(response, http.StatusInternalServerError, "ghost_code", "private-password-canary")
	body := commonErrorBody(t, response)
	if body["code"] != apierror.Internal || body["category"] != "internal" ||
		body["message"] != "Internal service error" || body["retryable"] != false {
		t.Fatalf("unknown code leaked its message: %v", body)
	}
}

func TestCommonErrorSCIMUnavailableExtension(t *testing.T) {
	schema := compileCommonErrorSchema(t)
	h := newTestHandler(t, &identityServiceStub{}, http.NotFoundHandler(), time.Now()).(*handler)
	response := httptest.NewRecorder()
	h.scimProxy.ErrorHandler(response, httptest.NewRequest(http.MethodGet, "/scim/v2/Users", nil), errors.New("down"))
	if response.Code != http.StatusServiceUnavailable ||
		response.Header().Get("Content-Type") != "application/scim+json" ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("SCIM failure response headers: %d %v", response.Code, response.Header())
	}
	body := commonErrorBody(t, response)
	if body["status"] != "503" || body["detail"] != "Identity Service is unavailable" {
		t.Fatalf("SCIM RFC shape changed: %v", body)
	}
	schemas, _ := body["schemas"].([]any)
	if len(schemas) != 1 || schemas[0] != "urn:ietf:params:scim:api:messages:2.0:Error" {
		t.Fatalf("SCIM schemas changed: %v", schemas)
	}
	extension, _ := body["urn:antnest:error"].(map[string]any)
	if extension == nil {
		t.Fatalf("urn:antnest:error extension missing: %v", body)
	}
	if err := schema.Validate(extension); err != nil {
		t.Fatalf("SCIM extension failed the common error schema: %v", err)
	}
	if extension["code"] != apierror.IdentityUnavailable || extension["category"] != "unavailable" ||
		extension["retryable"] != true || extension["request_id"] != response.Header().Get("X-Request-ID") {
		t.Fatalf("SCIM extension = %v with header %q", extension, response.Header().Get("X-Request-ID"))
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
		if !ok || function.Name != "writeError" || len(call.Args) < 3 {
			return true
		}
		if literal, ok := call.Args[2].(*ast.BasicLit); ok {
			problems = append(problems, name+": "+literal.Value)
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
		t.Fatalf("writeError code arguments must be generated constants: %v", problems)
	}
	mutation := literalErrorCodeArguments(t, "mutation.go", `package server
func probe(response http.ResponseWriter) {
	writeError(response, 500, "internal", "boom")
}
`)
	if len(mutation) == 0 {
		t.Fatal("the literal code check accepted a mutation")
	}
}
