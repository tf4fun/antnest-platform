package egressclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPendingAttachmentUsesVersionedControlContractWithoutPeerMaterial(t *testing.T) {
	calls := 0
	body := `{"agent_id":"agent-1","tunnel_ipv4":"100.64.0.2","resolver_ipv4":"100.64.0.1","packet_contract_revision":2,"egress_endpoint":{"ipv4":"10.20.0.8","port":8092},"state":"active","network_resource_version":1,"attachment_state":"pending","attachment_resource_version":2}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/internal/agent-network-attachments/agent-1" {
			var input map[string]any
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if r.Method != http.MethodPut || len(input) != 2 || input["state"] != "pending" || input["expected_resource_version"] != float64(1) {
				t.Errorf("bad pending mutation: %v %s", input, r.Method)
			}
		} else if r.URL.Path != "/internal/agent-networks/agent-1" {
			t.Error(r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	pending, err := client.SetAgentNetworkAttachment(t.Context(), "agent-1", "pending", 1, "", "")
	if err != nil || pending.AttachmentState != "pending" || pending.AttachmentResourceVersion != 2 {
		t.Fatalf("pending response: %+v %v", pending, err)
	}
	for _, read := range []func() error{
		func() error { _, err := client.GetAgentNetwork(t.Context(), "agent-1"); return err },
		func() error { _, err := client.EnsureAgentNetwork(t.Context(), "agent-1"); return err },
	} {
		if err := read(); err != nil {
			t.Fatal(err)
		}
	}
	before := calls
	for _, invalid := range [][2]string{{"10.20.0.9", ""}, {"", "rtk_0123456789abcdef0123456789abcdef"}} {
		if _, err := client.SetAgentNetworkAttachment(t.Context(), "agent-1", "pending", 2, invalid[0], invalid[1]); err == nil {
			t.Fatal("pending accepted peer material")
		}
	}
	if calls != before {
		t.Fatal("invalid request reached Egress")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]string{"runtime_endpoint": "10.20.0.9", "tunnel_key_id": "rtk_0123456789abcdef0123456789abcdef"} {
		payload[field] = value
		encoded, _ := json.Marshal(payload)
		if _, err := decodeNetworkAttachment(encoded, "agent-1", ""); err == nil {
			t.Fatalf("pending response accepted %s", field)
		}
		delete(payload, field)
	}
}
