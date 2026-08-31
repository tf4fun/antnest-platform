package egressclient

import (
	"context"
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
