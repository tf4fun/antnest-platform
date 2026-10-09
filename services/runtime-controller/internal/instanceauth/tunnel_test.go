package instanceauth

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestTunnelMaterialIsGenerationBoundSealedAndRecipientLimited(t *testing.T) {
	master := bytes.Repeat([]byte{31}, 32)
	issuer, _ := New(master)
	id := Identity{Scope: "scope-a", AgentID: "agent_a", Generation: 1}
	record, err := issuer.Issue(id)
	if err != nil {
		t.Fatal(err)
	}
	file, err := issuer.TunnelFile(id, record)
	if err != nil {
		t.Fatal(err)
	}
	var runtime map[string]string
	if err := json.Unmarshal(file, &runtime); err != nil {
		t.Fatal(err)
	}
	registration, err := issuer.TunnelRegistration(id, record, "rtv_0123456789abcdef0123456789abcdef", "100.96.0.10")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(record)
	outgoing, _ := json.Marshal(registration)
	if bytes.Contains(encoded, []byte(runtime["runtime_private_key"])) || bytes.Contains(encoded, []byte(runtime["preshared_key"])) || bytes.Contains(outgoing, []byte(runtime["runtime_private_key"])) {
		t.Fatal("recipient or durable record leaked private material")
	}
	if record.Tunnel.KeysDigest != Digest(file) || record.Tunnel.KeyID != runtime["key_id"] {
		t.Fatal("descriptor differs")
	}
	restarted, _ := New(master)
	again, err := restarted.TunnelFile(id, record)
	if err != nil || !bytes.Equal(file, again) {
		t.Fatal("accepted key changed on restart")
	}
	for _, wrong := range []Identity{{Scope: "other", AgentID: id.AgentID, Generation: 1}, {Scope: id.Scope, AgentID: "other", Generation: 1}, {Scope: id.Scope, AgentID: id.AgentID, Generation: 2}} {
		if _, err := restarted.TunnelFile(wrong, record); err == nil {
			t.Fatal("cross identity tunnel material opened")
		}
	}
	next, _ := issuer.Issue(Identity{Scope: id.Scope, AgentID: id.AgentID, Generation: 2})
	if next.Tunnel.KeyID == record.Tunnel.KeyID || next.Tunnel.KeysDigest == record.Tunnel.KeysDigest {
		t.Fatal("new generation reused tunnel material")
	}
	copyRecord := *record
	copyTunnel := *record.Tunnel
	copyTunnel.KeyID = next.Tunnel.KeyID
	copyRecord.Tunnel = &copyTunnel
	if _, err := issuer.TunnelFile(id, &copyRecord); err == nil {
		t.Fatal("key identity was not authenticated")
	}
}
