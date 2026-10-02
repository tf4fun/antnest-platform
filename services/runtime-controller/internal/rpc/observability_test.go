package rpc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

func TestRPCContentSwitchAndProtocolOutcome(t *testing.T) {
	for _, run := range []string{"first", "repeat"} {
		t.Run(run, testRPCContentSwitchAndProtocolOutcome)
	}
}

func testRPCContentSwitchAndProtocolOutcome(t *testing.T) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	rpcTestTracerProvider.RegisterSpanProcessor(recorder)
	t.Cleanup(func() {
		rpcTestTracerProvider.UnregisterSpanProcessor(recorder)
	})
	operation := deployment.Operation{
		RequestID: "operation-42", AgentID: "agent-1", Kind: deployment.OperationInitializeRuntime,
		RuntimeRevision: testRuntimeRevision, State: deployment.OperationCompleted, Effect: deployment.EffectCompleted,
		ErrorDetail: "ERROR_DETAIL_CANARY",
	}
	body := `{"configuration":{"image_ref":"antnest/runtime:test","resources":{"memory_bytes":1048576,"pids_limit":64,"tmpfs_bytes":4096},"mcp_servers":[{"id":"tool","command":"COMMAND_CANARY","args":["ARG_CANARY"],"env":{"TOKEN":"NESTED_CANARY"}}]}}`
	for _, test := range []struct {
		name, flag, body string
		capture          bool
	}{
		{"enabled", "true", body, true}, {"disabled", "false", body, false},
		{"partial", "true", body[:len(body)-1], false},
		{"large", "true", strings.Replace(body, "NESTED_CANARY", strings.Repeat("CANARY", 4000), 1), true},
		{"unknown", "true", `{"unknown":"CANARY"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder.Reset()
			t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", test.flag)
			handler := telemetry.HTTPHandler(newTestHandler(t, &fakeService{operation: operation}))
			request := httptest.NewRequest(http.MethodPost, "/internal/runtimes/agent-1/initialize", strings.NewReader(test.body))
			request.Header.Set("Idempotency-Key", "operation-42")
			request.Header.Set("Cookie", "COOKIE_CANARY")
			handler.ServeHTTP(httptest.NewRecorder(), request)
			server := recordedRPCServerSpan(t, recorder)
			if server.Name() != "HTTP POST /internal/runtimes/{agent_id}/initialize" {
				t.Fatal("RPC route changed")
			}
			var payload string
			for _, event := range server.Events() {
				if event.Name == "antnest.request" {
					payload = eventAttributes(event.Attributes)["antnest.payload.json"].AsString()
				}
			}
			if test.capture {
				var recorded struct {
					Params json.RawMessage `json:"params"`
				}
				if err := json.Unmarshal([]byte(payload), &recorded); err != nil {
					t.Fatal(err)
				}
				var want initializeRequest
				if err := json.Unmarshal([]byte(test.body), &want); err != nil {
					t.Fatal(err)
				}
				expected, err := json.Marshal(want)
				if err != nil {
					t.Fatal(err)
				}
				if string(recorded.Params) != string(expected) {
					t.Fatal("RPC parameters changed during capture")
				}
				if !strings.Contains(payload, "COMMAND_CANARY") || !strings.Contains(payload, "ARG_CANARY") {
					t.Fatal("MCP contents projected")
				}
				if test.name == "large" && !strings.Contains(payload, strings.Repeat("CANARY", 4000)) {
					t.Fatal("RPC body limited")
				}
				if !strings.Contains(fmt.Sprint(server.Events()), "ERROR_DETAIL_CANARY") {
					t.Fatal("RPC result projected")
				}
			} else if payload != "" {
				t.Fatal("disabled or unparsed request was captured")
			}
			if strings.Contains(fmt.Sprint(server.Attributes()), "COOKIE_CANARY") {
				t.Fatal("HTTP header captured")
			}
		})
	}

	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder.Reset()
	operation.State = deployment.OperationFailed
	operation.ErrorCode = "platform_unavailable"
	handler := telemetry.HTTPHandler(newTestHandler(t, &fakeService{operation: operation}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/runtime-operations/operation-42", nil))
	server := recordedRPCServerSpan(t, recorder)
	if response.Code != http.StatusOK || server.Status().Code != codes.Error {
		t.Fatal("HTTP 200 hid failed operation status")
	}
	for _, event := range server.Events() {
		if event.Name != "antnest.error" {
			continue
		}
		attrs := eventAttributes(event.Attributes)
		for _, key := range []attribute.Key{"antnest.error.stage", "antnest.error.type", "antnest.error.code", "antnest.error.message", "antnest.error.causes"} {
			if attrs[key].Type() != attribute.STRING {
				t.Fatalf("error field %s is not string", key)
			}
		}
		if attrs["antnest.error.cause_types"].Type() != attribute.STRINGSLICE {
			t.Fatal("cause_types is not string[]")
		}
		if !json.Valid([]byte(attrs["antnest.error.causes"].AsString())) {
			t.Fatal("causes is not bounded JSON")
		}
	}
}

func recordedRPCServerSpan(t *testing.T, recorder *tracetest.SpanRecorder) sdktrace.ReadOnlySpan {
	t.Helper()
	spans := recorder.Ended()
	if len(spans) == 0 {
		t.Fatal("RPC HTTP handler did not emit any spans")
	}
	server := spans[len(spans)-1]
	if server.SpanKind() != trace.SpanKindServer {
		t.Fatalf("RPC HTTP handler's last span has kind %s, want SERVER", server.SpanKind())
	}
	return server
}

func eventAttributes(values []attribute.KeyValue) map[attribute.Key]attribute.Value {
	result := make(map[attribute.Key]attribute.Value)
	for _, item := range values {
		result[item.Key] = item.Value
	}
	return result
}
