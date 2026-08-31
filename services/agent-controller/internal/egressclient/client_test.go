package egressclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

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
