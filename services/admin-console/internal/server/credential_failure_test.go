package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
	"go.opentelemetry.io/otel/codes"
)

const createUserRequest = `{"email":"alice@example.com","display_name":"Alice","password":"private-create-password","role":"member"}`
const createUserSuccess = `{"user":{"id":"user-new","system_role":"user","active":true},"membership":{"id":"member-new","user_id":"user-new","email":"alice@example.com","display_name":"Alice","role":"member","source":"local","active":true}}`
const createUserBusy = `{"code":"credential_busy","message":"Password verification is busy","retryable":true}`

// Keep header/fetch failure injection local to the password-consuming route.
type createUserBackend struct {
	*backendStub
	header http.Header
	fault  string
	closed bool
}

func (b *createUserBackend) Do(ctx context.Context, target upstream.Target, method, path, query string, body []byte) (*http.Response, error) {
	response, err := b.backendStub.Do(ctx, target, method, path, query, body)
	if err != nil {
		return nil, err
	}
	response.Header = b.header.Clone()
	switch b.fault {
	case "transport":
		_ = response.Body.Close()
		return nil, errors.New("private-create-password in transport failure")
	case "cancelled", "deadline":
		_ = response.Body.Close()
		var waiting context.Context
		var cancel context.CancelFunc
		if b.fault == "cancelled" {
			waiting, cancel = context.WithCancel(ctx)
			cancel()
		} else {
			waiting, cancel = context.WithTimeout(ctx, time.Millisecond)
		}
		defer cancel()
		<-waiting.Done()
		return nil, fmt.Errorf("private-create-password in cancelled dependency: %w", waiting.Err())
	case "nil response":
		_ = response.Body.Close()
		return nil, nil
	case "nil body":
		_ = response.Body.Close()
		response.Body = nil
	case "read":
		_ = response.Body.Close()
		response.Body = &createUserReadFailure{closed: &b.closed}
	}
	return response, nil
}

type createUserReadFailure struct{ closed *bool }

func (*createUserReadFailure) Read([]byte) (int, error) {
	return 0, errors.New("private-create-password in response body failure")
}
func (r *createUserReadFailure) Close() error { *r.closed = true; return nil }

func TestCreateLocalUserPasswordAdmission(t *testing.T) {
	type testCase struct {
		name, body, fault string
		status            int
		retry             []string
		valid             bool
	}
	cases := []testCase{
		{name: "canonical busy", status: 503, body: createUserBusy, retry: []string{"1"}, valid: true},
		{name: "wrong status", status: 429, body: createUserBusy, retry: []string{"1"}},
		{name: "redirect", status: 307, body: createUserBusy, retry: []string{"1"}},
		{name: "success status", status: 200, body: createUserBusy, retry: []string{"1"}},
		{name: "mixed success and failure", status: 201, body: strings.TrimSuffix(createUserSuccess, "}") + `,"code":"credential_busy","message":"Password verification is busy","retryable":true}`, retry: []string{"1"}},
		{name: "mixed case failure", status: 200, body: strings.TrimSuffix(createUserSuccess, "}") + `,"CoDe":"credential_busy"}`, retry: []string{"1"}},
		{name: "create has no rate counter", status: 429, body: `{"code":"credential_rate_limited","message":"Too many password attempts","retryable":true}`, retry: []string{"1"}},
		{name: "private message", status: 503, body: `{"code":"credential_busy","message":"private-create-password","retryable":true}`, retry: []string{"1"}},
		{name: "extra field", status: 503, body: strings.TrimSuffix(createUserBusy, "}") + `,"password":"private-create-password"}`, retry: []string{"1"}},
		{name: "duplicate code", status: 503, body: strings.TrimSuffix(createUserBusy, "}") + `,"code":"credential_busy"}`, retry: []string{"1"}},
		{name: "case alias", status: 503, body: strings.Replace(createUserBusy, `"code"`, `"Code"`, 1), retry: []string{"1"}},
		{name: "missing retryable", status: 503, body: `{"code":"credential_busy","message":"Password verification is busy"}`, retry: []string{"1"}},
		{name: "false retryable", status: 503, body: strings.Replace(createUserBusy, "true", "false", 1), retry: []string{"1"}},
		{name: "null retryable", status: 503, body: strings.Replace(createUserBusy, "true", "null", 1), retry: []string{"1"}},
		{name: "string retryable", status: 503, body: strings.Replace(createUserBusy, "true", `"true"`, 1), retry: []string{"1"}},
		{name: "empty body", status: 503},
		{name: "array", status: 503, body: "[" + createUserBusy + "]", retry: []string{"1"}},
		{name: "null", status: 503, body: "null", retry: []string{"1"}},
		{name: "trailing object", status: 503, body: createUserBusy + `{}`, retry: []string{"1"}},
		{name: "invalid UTF8", status: 503, body: createUserBusy + string([]byte{255}), retry: []string{"1"}},
		{name: "unknown code", status: 503, body: `{"code":"private-create-password","message":"private-create-password"}`, retry: []string{"1"}},
		{name: "legacy code wrong status", status: 503, body: `{"code":"forbidden","message":"Denied","retryable":false}`, retry: []string{"1"}},
		{name: "legacy code wrong retryable", status: 403, body: `{"code":"forbidden","message":"Denied","retryable":true}`, retry: []string{"1"}},
		{name: "oversized body", status: 503, body: strings.Repeat("x", maximumResponseBytes+1), retry: []string{"1"}},
	}
	for name, retry := range map[string][]string{
		"missing": nil, "duplicate": {"1", "1"}, "empty": {""}, "zero": {"0"},
		"too long": {"2"}, "negative": {"-1"}, "signed": {"+1"}, "leading zero": {"01"},
		"fraction": {"1.0"}, "leading whitespace": {" 1"}, "trailing whitespace": {"1 "},
		"newline": {"1\n"}, "comma": {"1, 1"}, "date": {"Wed, 21 Oct 2026 07:28:00 GMT"},
		"overflow": {"99999999999999999999"},
	} {
		cases = append(cases, testCase{name: "Retry-After " + name, status: 503, body: createUserBusy, retry: retry})
	}
	for _, fault := range []string{"transport", "nil response", "nil body", "read"} {
		cases = append(cases, testCase{name: fault, status: 503, body: createUserBusy, retry: []string{"1"}, fault: fault})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			backend := &createUserBackend{backendStub: newBackendStub(), header: http.Header{
				"Retry-After": tc.retry, "Content-Type": {"application/json"},
				"Cache-Control": {"public, max-age=3600"}, "Set-Cookie": {"private-create-password=secret"},
			}, fault: tc.fault}
			backend.enqueue(tc.status, tc.body)
			handler := newTestHandler(t, backend)
			response := requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/users", createUserRequest)
			if response.Code != 503 || response.Header().Get("Cache-Control") != "no-store" || len(response.Result().Cookies()) != 0 {
				t.Fatalf("unsafe response: status=%d headers=%v", response.Code, response.Header())
			}
			want := map[string]any{"code": "identity_unavailable", "message": "Identity Service is unavailable"}
			var wantRetry []string
			if tc.valid {
				want = map[string]any{"code": "credential_busy", "message": "Password verification is busy", "retryable": true}
				wantRetry = []string{"1"}
			}
			var got map[string]any
			decodeBytes(t, response.Body.Bytes(), &got)
			if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(response.Header().Values("Retry-After"), wantRetry) {
				t.Fatalf("failure projection=%v retry=%v", got, response.Header().Values("Retry-After"))
			}
			call := backend.singleCall(t)
			if call.Target != upstream.Identity || call.Method != http.MethodPost || call.Path != "/rpc/identity/create-local-user" || call.Query != "" {
				t.Fatal("create-user did not make exactly one owning RPC")
			}
			if tc.fault == "read" && !backend.closed {
				t.Fatal("failed response body was not closed")
			}
			backend.fault = ""
			backend.header = http.Header{"Content-Type": {"application/json"}}
			backend.enqueue(201, createUserSuccess)
			recovered := requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/users", createUserRequest)
			if recovered.Code != 201 || len(backend.calls) != 2 || len(recovered.Result().Cookies()) != 0 || !strings.Contains(recovered.Body.String(), `"id":"user-new"`) {
				t.Fatal("explicit later create did not recover without extra RPCs")
			}
		})
	}
}

func TestCreateLocalUserBusyDoesNotExpandOtherRoutesHeaderPolicy(t *testing.T) {
	backend := &createUserBackend{backendStub: newBackendStub(), header: http.Header{"Retry-After": {"1"}}}
	backend.enqueue(503, createUserBusy)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, "/api/admin/directory", "")
	if response.Header().Get("Retry-After") != "" {
		t.Fatal("create-user expanded the generic response header allowlist")
	}
	backend.singleCall(t)
}

func TestCreateLocalUserLegacyFailuresStayBounded(t *testing.T) {
	for _, tc := range []struct {
		code, message string
		status        int
		retryable     bool
	}{
		{"invalid_argument", "The request contains an invalid argument", 400, false},
		{"bad_request", "Identity request is invalid", 400, false},
		{"forbidden", "The principal is not allowed to perform this operation", 403, false},
		{"not_found", "The requested identity resource does not exist", 404, false},
		{"conflict", "The identity resource conflicts with an existing resource", 409, false},
		{"caller_context_required", "Caller context is required", 401, false},
		{"caller_context_invalid", "Caller context verification failed", 401, false},
		{"service_unauthenticated", "Service authentication rejected", 401, false},
		{"caller_not_allowed", "Service caller is not allowed", 403, false},
		{"actor_mismatch", "Actor does not match caller context", 403, false},
		{"unsupported_media_type", "Identity request content type is invalid", 415, false},
		{"internal_error", "Identity Service could not complete the request", 500, true},
		{"identity_dependency_unavailable", "Identity authorization dependency is unavailable", 503, true},
	} {
		t.Run(tc.code, func(t *testing.T) {
			backend := &createUserBackend{backendStub: newBackendStub(), header: http.Header{"Retry-After": {"private-create-password"}}}
			retryable := "false"
			if tc.retryable {
				retryable = "true"
			}
			backend.enqueue(tc.status, `{"code":"`+tc.code+`","message":"private-create-password","retryable":`+retryable+`}`)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/directory/users", createUserRequest)
			var got map[string]any
			decodeBytes(t, response.Body.Bytes(), &got)
			want := map[string]any{"code": tc.code, "message": tc.message, "retryable": tc.retryable}
			if response.Code != tc.status || !reflect.DeepEqual(got, want) || response.Header().Get("Retry-After") != "" || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("legacy failure status=%d body=%v", response.Code, got)
			}
			backend.singleCall(t)
		})
	}
}

func TestCreateLocalUserPasswordFailureDiagnosticsAreBounded(t *testing.T) {
	for _, code := range []string{"credential_busy", "identity_unavailable"} {
		if safeErrorCode(code) != code {
			t.Fatalf("password failure %s lost its bounded diagnostic code", code)
		}
	}
}

func TestCreateLocalUserRetryAfterHeaderCasing(t *testing.T) {
	for _, tc := range []struct {
		name   string
		header http.Header
		valid  bool
	}{
		{"lowercase", http.Header{"retry-after": {"1"}}, true},
		{"mixed case", http.Header{"rEtRy-AfTeR": {"1"}}, true},
		{"duplicate spellings", http.Header{"Retry-After": {"1"}, "retry-after": {"1"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			backend := &createUserBackend{backendStub: newBackendStub(), header: tc.header}
			backend.enqueue(503, createUserBusy)
			response := requestAdmin(t, newTestHandler(t, backend), http.MethodPost, "/api/admin/directory/users", createUserRequest)
			code, retry := "identity_unavailable", ""
			if tc.valid {
				code, retry = "credential_busy", "1"
			}
			if response.Code != 503 || response.Header().Get("Retry-After") != retry || !strings.Contains(response.Body.String(), `"code":"`+code+`"`) {
				t.Fatal("header casing changed password admission semantics")
			}
			backend.singleCall(t)
		})
	}
}

var _ io.ReadCloser = (*createUserReadFailure)(nil)

func TestCreateLocalUserFetchFailuresKeepSafeDiagnostics(t *testing.T) {
	for _, fault := range []string{"transport", "read", "cancelled", "deadline"} {
		t.Run(fault, func(t *testing.T) {
			recorder := consoleTraceRecorder(t)
			backend := &createUserBackend{backendStub: newBackendStub(), fault: fault}
			var logs bytes.Buffer
			handler := telemetry.HTTPHandler(newTestHandler(t, backend), slog.New(slog.NewTextHandler(&logs, nil)))
			response := requestAdmin(t, handler, http.MethodPost, "/api/admin/directory/users", createUserRequest)
			if response.Code != 503 || len(response.Result().Cookies()) != 0 || response.Header().Get("Retry-After") != "" {
				t.Fatal("fetch failure changed public admission semantics")
			}
			backend.singleCall(t)
			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("expected one SERVER span, got %d", len(spans))
			}
			span := spans[0]
			if (span.Status().Code == codes.Error) == (fault == "cancelled") {
				t.Fatal("cancellation and failure lost their distinct span status")
			}
			observed := fmt.Sprint(span.Attributes(), span.Events(), logs.String(), response.Body.String())
			if strings.Contains(observed, "private-create-password") || !strings.Contains(observed, "identity_unavailable") {
				t.Fatal("fetch failure lost its safe code or disclosed private input")
			}
			for _, attr := range span.Attributes() {
				if attr.Key == "antnest.outcome" && fault == "cancelled" && attr.Value.AsString() != "cancelled" {
					t.Fatal("dependency cancellation was recorded as ordinary failure")
				}
			}
			if fault == "deadline" && !strings.Contains(observed, "Request deadline exceeded") {
				t.Fatal("safe timeout cause was lost")
			}
		})
	}
}
