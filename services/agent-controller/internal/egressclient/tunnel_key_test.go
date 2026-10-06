package egressclient

import (
	"encoding/json"
	"testing"
)

func TestOpenAttachmentRequiresItsPreparedGenerationIdentity(t *testing.T) {
	for _, key := range []any{nil, "", "rtk_bad", "rtk_0123456789ABCDEF0123456789abcdef"} {
		raw := map[string]any{
			"agent_id": "agent-1", "tunnel_ipv4": "100.64.0.2", "resolver_ipv4": "100.64.0.1",
			"packet_contract_revision": 2, "egress_endpoint": map[string]any{"ipv4": "10.20.0.8", "port": 8092},
			"state": "active", "network_resource_version": 1, "attachment_state": "open",
			"attachment_resource_version": 2, "runtime_endpoint": "10.243.1.20", "tunnel_key_id": key,
		}
		body, _ := json.Marshal(raw)
		if _, err := decodeNetworkAttachment(body, "agent-1", ""); err == nil {
			t.Fatal("accepted open attachment without canonical key identity", key)
		}
	}
}
