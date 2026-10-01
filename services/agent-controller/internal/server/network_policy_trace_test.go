package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestNetworkPolicyFlowTraceIncludesResponseValidation(t *testing.T) {
	recorder := networkPolicyTraceRecorder(t)
	for _, scenario := range []struct {
		name, traceID, failPath, errorOperation string
		upstreamStatus, status, clients         int
	}{
		{"read", "4bf92f3577b34da6a3ce929d0e0e4736", "", "", 200, 200, 3},
		{"malformed assignment", "5bf92f3577b34da6a3ce929d0e0e4736", "/internal/agent-policy-assignments/agent-1", "get_policy_assignment", 200, 502, 1},
		{"invalid attachment error", "6bf92f3577b34da6a3ce929d0e0e4736", "/internal/agent-networks/agent-1", "get_agent_network", 503, 502, 3},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			requests := make(chan policyFlowRequest, 4)
			handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
				recordPolicyFlowRequest(t, r, requests)
				body := policyFlowReadBody(r.URL.EscapedPath())
				if r.URL.EscapedPath() == scenario.failPath {
					w.WriteHeader(scenario.upstreamStatus)
					body = `{"code":"private-upstream-data"}`
				}
				writePolicyFlowBody(t, w, body)
			})
			request := httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/network-policy?organization_id=org-1", nil)
			request.Header.Set("traceparent", "00-"+scenario.traceID+"-00f067aa0ba902b7-01")
			response := httptest.NewRecorder()
			telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(response, request)
			if response.Code != scenario.status || strings.Contains(response.Body.String(), "private-upstream-data") {
				t.Fatalf("response=%d %s", response.Code, response.Body.String())
			}
			root, children := networkPolicySpans(t, recorder.Ended(), scenario.traceID)
			if root.Parent().SpanID().String() != "00f067aa0ba902b7" || root.Name() != "HTTP GET /internal/agents/{agent_id}/network-policy" {
				t.Fatalf("Controller root=%s parent=%s", root.Name(), root.Parent().SpanID())
			}
			if len(children) != scenario.clients || len(requests) != scenario.clients {
				t.Fatalf("client spans=%d requests=%d", len(children), len(requests))
			}
			for _, child := range children {
				if child.Parent().SpanID() != root.SpanContext().SpanID() {
					t.Fatalf("detached Egress client: %s", child.Name())
				}
				if strings.Contains(child.Status().Description, "private-upstream-data") {
					t.Fatal("unbounded error in trace")
				}
				if spanRPCMethod(child) == scenario.errorOperation && scenario.errorOperation != "" && child.Status().Code != codes.Error {
					t.Fatalf("invalid response reported successful: %s", child.Name())
				}
			}
			assertNetworkTraceHeaders(t, requests, children, scenario.clients)
			if scenario.status != 200 && root.Status().Code != codes.Error {
				t.Fatal("invalid response not recorded on Controller span")
			}
		})
	}
}

func networkPolicyTraceRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	return recorder
}

func TestNetworkPolicyMutationTraceAndAudit(t *testing.T) {
	recorder := networkPolicyTraceRecorder(t)
	for _, scenario := range []struct {
		name, traceID, body, errorCode string
		upstreamStatus, status         int
	}{
		{"success", "7bf92f3577b34da6a3ce929d0e0e4736", policyFlowAssignment, "", 200, 200},
		{"conflict", "8bf92f3577b34da6a3ce929d0e0e4736", `{"code":"resource_version_conflict"}`, "resource_version_conflict", 409, 409},
		{"truncated", "9bf92f3577b34da6a3ce929d0e0e4736", `{}`, "dependency_invalid_response", 200, 502},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			previous := slog.Default()
			slog.SetDefault(logger)
			t.Cleanup(func() { slog.SetDefault(previous) })
			requests := make(chan policyFlowRequest, 2)
			handler, _ := policyFlowHandler(t, func(w http.ResponseWriter, r *http.Request) {
				recordPolicyFlowRequest(t, r, requests)
				if scenario.name == "truncated" {
					w.Header().Set("Content-Length", "100")
				}
				w.WriteHeader(scenario.upstreamStatus)
				writePolicyFlowBody(t, w, scenario.body)
			})
			request := httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/network-policy", strings.NewReader(networkMutationJSON))
			request.Header.Set("traceparent", "00-"+scenario.traceID+"-00f067aa0ba902b7-01")
			response := httptest.NewRecorder()
			telemetry.HTTPHandler(handler, logger).ServeHTTP(response, request)
			if response.Code != scenario.status {
				t.Fatalf("mutation=%d %s", response.Code, response.Body.String())
			}
			root, children := networkPolicySpans(t, recorder.Ended(), scenario.traceID)
			if root.Parent().SpanID().String() != "00f067aa0ba902b7" || len(children) != 1 || len(requests) != 1 {
				t.Fatalf("mutation ancestry=%s children=%d calls=%d", root.Parent().SpanID(), len(children), len(requests))
			}
			for _, child := range children {
				if child.Parent().SpanID() != root.SpanContext().SpanID() || child.Name() != "HTTP PUT runtime-egress" || spanRPCMethod(child) != "set_policy_assignment" {
					t.Fatalf("mutation client=%s parent=%s", child.Name(), child.Parent().SpanID())
				}
				if scenario.errorCode != "" && child.Status().Code != codes.Error {
					t.Fatal("failed mutation client not traced as error")
				}
			}
			assertNetworkTraceHeaders(t, requests, children, 1)
			assertNetworkMutationAudit(t, root, logs.String(), scenario.errorCode)
		})
	}
}

func spanRPCMethod(span sdktrace.ReadOnlySpan) string {
	for _, attr := range span.Attributes() {
		if string(attr.Key) == "rpc.method" {
			return attr.Value.AsString()
		}
	}
	return ""
}

func assertNetworkMutationAudit(t *testing.T, root sdktrace.ReadOnlySpan, logs, errorCode string) {
	t.Helper()
	attributes := map[string]string{}
	for _, attr := range root.Attributes() {
		attributes[string(attr.Key)] = attr.Value.AsString()
	}
	for key, want := range map[string]string{"antnest.request.id": "request-1", "antnest.organization.id": "org-1", "antnest.agent.id": "agent-1", "antnest.actor.id": "admin-1", "antnest.policy.id": "builtin/allow-all"} {
		if attributes[key] != want {
			t.Fatalf("missing audit attribute %s=%s", key, want)
		}
	}
	result := "success"
	if errorCode != "" {
		result = "error"
		if root.Status().Code != codes.Error || attributes["error.type"] != errorCode {
			t.Fatalf("error audit=%v %+v", root.Status(), attributes)
		}
	}
	if attributes["antnest.result"] != result {
		t.Fatalf("mutation result=%+v", attributes)
	}
	for _, field := range []string{`"request_id":"request-1"`, `"organization_id":"org-1"`, `"agent_id":"agent-1"`, `"actor_principal_id":"admin-1"`, `"policy_id":"builtin/allow-all"`, `"policy_revision":1`, `"expected_resource_version":7`, `"result":"` + result + `"`, `"error_class":"` + errorCode + `"`} {
		if !strings.Contains(logs, field) {
			t.Fatalf("missing %s in audit log: %s", field, logs)
		}
	}
}

func networkPolicySpans(t *testing.T, spans []sdktrace.ReadOnlySpan, traceID string) (sdktrace.ReadOnlySpan, map[trace.SpanID]sdktrace.ReadOnlySpan) {
	t.Helper()
	var root sdktrace.ReadOnlySpan
	children := map[trace.SpanID]sdktrace.ReadOnlySpan{}
	for _, span := range spans {
		if span.SpanContext().TraceID().String() != traceID {
			continue
		}
		if span.SpanKind() == trace.SpanKindServer {
			root = span
			continue
		}
		children[span.SpanContext().SpanID()] = span
	}
	if root == nil {
		t.Fatal("missing Controller server span")
	}
	return root, children
}

func assertNetworkTraceHeaders(t *testing.T, requests <-chan policyFlowRequest, children map[trace.SpanID]sdktrace.ReadOnlySpan, count int) {
	t.Helper()
	for range count {
		request := <-requests
		ctx := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{"traceparent": request.traceparent})
		remote := trace.SpanContextFromContext(ctx)
		child, ok := children[remote.SpanID()]
		if !ok || child.SpanContext().TraceID() != remote.TraceID() {
			t.Fatalf("Egress request is not a client-span child: %+v", request)
		}
	}
}
