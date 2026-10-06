package egressclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAttachmentOpenForwardsOnlyCanonicalRuntimePeer(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["state"] != "open" || body["runtime_endpoint"] != "10.243.1.20" || body["expected_resource_version"] != float64(7) {
			t.Fatal(body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent_id":"agent-1","tunnel_ipv4":"100.64.0.2","resolver_ipv4":"100.64.0.1","packet_contract_revision":2,"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},"state":"active","network_resource_version":1,"attachment_state":"open","tunnel_key_id":"rtk_0123456789abcdef0123456789abcdef","attachment_resource_version":8,"runtime_endpoint":"10.243.1.20"}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for _, peer := range []string{"", "runtime", "http://runtime/mcp", "::1", "0.0.0.0", "010.243.1.20", " 10.243.1.20 "} {
		if _, err := client.SetAgentNetworkAttachment(context.Background(), "agent-1", ports.NetworkAttachmentOpen, 7, peer, "rtk_0123456789abcdef0123456789abcdef"); err == nil {
			t.Fatal("invalid peer accepted", peer)
		}
	}
	if calls != 0 {
		t.Fatal("invalid peer reached dependency")
	}
	opened, err := client.SetAgentNetworkAttachment(t.Context(), "agent-1", ports.NetworkAttachmentOpen, 7, "10.243.1.20", "rtk_0123456789abcdef0123456789abcdef")
	if err != nil || opened.RuntimeEndpoint != "10.243.1.20" || calls != 1 {
		t.Fatal(opened, err, calls)
	}
}

func TestAttachmentOpenRejectsAcknowledgementForAnotherPeer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent_id":"agent-1","tunnel_ipv4":"100.64.0.2","resolver_ipv4":"100.64.0.1","packet_contract_revision":2,"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},"state":"active","network_resource_version":1,"attachment_state":"open","tunnel_key_id":"rtk_0123456789abcdef0123456789abcdef","attachment_resource_version":8,"runtime_endpoint":"10.243.1.21"}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.SetAgentNetworkAttachment(t.Context(), "agent-1", ports.NetworkAttachmentOpen, 7, "10.243.1.20", "rtk_0123456789abcdef0123456789abcdef"); err == nil {
		t.Fatal("accepted acknowledgement for another Runtime peer")
	}
}
