package egressclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestEnsureAgentNetworkUsesEgressControlContract(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/internal/agent-networks/agent-1" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"tunnel_ipv4":"100.64.0.2",
			"resolver_ipv4":"100.64.0.1",
			"packet_contract_revision":1,
			"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},
			"state":"active"
		}`))
	}))
	t.Cleanup(server.Close)

	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	attachment, err := client.EnsureAgentNetwork(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("ensure Agent network: %v", err)
	}
	if attachment.AgentID != "agent-1" || attachment.TunnelIPv4 != "100.64.0.2" ||
		attachment.EgressIPv4 != "10.20.0.8" || attachment.EgressPort != 8092 {
		t.Fatalf("attachment = %+v", attachment)
	}
}

func TestGetAgentNetworkReadsAuthoritativeActiveAttachment(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/internal/agent-networks/agent-1" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"tunnel_ipv4":"100.64.0.2",
			"resolver_ipv4":"100.64.0.1",
			"packet_contract_revision":1,
			"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},
			"state":"active"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	attachment, err := client.GetAgentNetwork(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("get Agent network: %v", err)
	}
	if attachment.AgentID != "agent-1" || attachment.State != "active" ||
		attachment.TunnelIPv4 != "100.64.0.2" {
		t.Fatalf("attachment = %+v", attachment)
	}
}

func TestRebuildNetworkBarriersUseEgressControlContract(t *testing.T) {
	t.Parallel()

	wantPaths := []string{
		"/internal/agent-networks/agent-1/fence",
		"/internal/agent-networks/agent-1/reset-flows",
	}
	call := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || call >= len(wantPaths) || request.URL.Path != wantPaths[call] {
			t.Fatalf("request %d = %s %s", call, request.Method, request.URL.Path)
		}
		call++
		response.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	if err := client.FenceAgentNetwork(context.Background(), "agent-1"); err != nil {
		t.Fatalf("fence Agent network: %v", err)
	}
	if err := client.ResetAgentFlows(context.Background(), "agent-1"); err != nil {
		t.Fatalf("reset Agent flows: %v", err)
	}
	if call != len(wantPaths) {
		t.Fatalf("calls = %d, want %d", call, len(wantPaths))
	}
}

func TestPolicyAssignmentRoundTripUsesEgressControlContract(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/agent-policy-assignments/agent-1" {
			t.Fatalf("request path = %s", request.URL.Path)
		}
		resourceVersion := uint64(7)
		if request.Method == http.MethodPut {
			var payload struct {
				PolicyID                string `json:"policy_id"`
				Revision                uint64 `json:"revision"`
				ExpectedResourceVersion uint64 `json:"expected_resource_version"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode assignment request: %v", err)
			}
			if payload.PolicyID != "internet-enabled" || payload.Revision != 3 ||
				payload.ExpectedResourceVersion != 7 {
				t.Fatalf("assignment request = %+v", payload)
			}
			resourceVersion = 8
		} else if request.Method != http.MethodGet {
			t.Fatalf("request method = %s", request.Method)
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"agent_id": "agent-1", "policy_id": "internet-enabled",
			"revision": 3, "resource_version": resourceVersion,
		})
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	current, err := client.GetAgentPolicyAssignment(context.Background(), "agent-1")
	if err != nil || current.ResourceVersion != 7 {
		t.Fatalf("get assignment = %+v, %v", current, err)
	}
	restored, err := client.AssignAgentPolicy(context.Background(), current, current.ResourceVersion)
	if err != nil || restored.ResourceVersion != 8 || restored.PolicyID != current.PolicyID {
		t.Fatalf("assign policy = %+v, %v", restored, err)
	}
}

func TestEnsureAgentNetworkReturnsStableDependencyFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte(`{"code":"cleanup_failed","message":"unavailable","retryable":true}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	_, err = client.EnsureAgentNetwork(context.Background(), "agent-1")
	var dependencyError *ports.DependencyError
	if !errors.As(err, &dependencyError) || dependencyError.Service != "runtime-egress" ||
		dependencyError.Code != "cleanup_failed" || !dependencyError.Retryable {
		t.Fatalf("dependency error = %#v (%v)", dependencyError, err)
	}
}

func TestEnsureAgentNetworkRejectsInactiveAttachment(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"tunnel_ipv4":"100.64.0.2",
			"resolver_ipv4":"100.64.0.1",
			"packet_contract_revision":1,
			"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},
			"state":"quarantined"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	_, err = client.EnsureAgentNetwork(context.Background(), "agent-1")
	var dependencyError *ports.DependencyError
	if !errors.As(err, &dependencyError) || dependencyError.Code != "invalid_response" {
		t.Fatalf("inactive attachment error = %#v (%v)", dependencyError, err)
	}
}

func TestEnsureAgentNetworkPropagatesTraceContext(t *testing.T) {
	previous := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previous) })

	const expected = "00-11111111111111111111111111111111-2222222222222222-01"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if actual := request.Header.Get("traceparent"); actual != expected {
			t.Fatalf("traceparent = %q, want %q", actual, expected)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"tunnel_ipv4":"100.64.0.2",
			"resolver_ipv4":"100.64.0.1",
			"packet_contract_revision":1,
			"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},
			"state":"active"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	ctx := trace.ContextWithRemoteSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
			0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11},
		SpanID:     trace.SpanID{0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22},
		TraceFlags: trace.FlagsSampled, Remote: true,
	}))
	if _, err := client.EnsureAgentNetwork(ctx, "agent-1"); err != nil {
		t.Fatalf("ensure Agent network: %v", err)
	}
}
