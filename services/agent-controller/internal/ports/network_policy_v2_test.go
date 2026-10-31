package ports

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

const testV2Spec = `{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"],"ports":[443]},{"action":"allow","cidrs":["10.20.0.15/32"],"ports":[{"from":400,"to":450}]}]}`

func TestNetworkPolicySpecCodecRoundTripsV1AndV2(t *testing.T) {
	for _, document := range []string{
		`{"schema_version":1,"action":"allow_all"}`,
		`{"schema_version":1,"action":"deny_all"}`,
		`{"schema_version":2,"default":"allow","rules":[]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow"},{"action":"deny","protocol":"tcp"}]}`,
		testV2Spec,
	} {
		var spec NetworkPolicySpec
		if err := json.Unmarshal([]byte(document), &spec); err != nil {
			t.Fatalf("valid document rejected: %s %v", document, err)
		}
		encoded, err := json.Marshal(spec)
		if err != nil {
			t.Fatalf("marshal failed: %v", err)
		}
		if string(encoded) != document {
			t.Fatalf("canonical bytes drifted: %s -> %s", document, encoded)
		}
	}
	v1, _ := json.Marshal(NetworkPolicySpec{SchemaVersion: 1, Action: "deny_all"})
	if string(v1) != `{"schema_version":1,"action":"deny_all"}` {
		t.Fatalf("v1 bytes changed: %s", v1)
	}
	v2, _ := json.Marshal(NetworkPolicySpec{SchemaVersion: 2, Default: "allow"})
	if string(v2) != `{"schema_version":2,"default":"allow","rules":[]}` {
		t.Fatalf("empty rules must serialize []: %s", v2)
	}
}

func TestNetworkPolicySpecRejectsMalformedAndMixedDocuments(t *testing.T) {
	invalid := []string{
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","protocol":""}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","protocol":"TCP"}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[null]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":null}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":null}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"Action":"allow"}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","action":"deny"}]}`,
		`{"schema_version":2,"default":"deny","default":"deny","rules":[]}`,
		`{"schema_version":3,"action":"allow_all"}`,
		`{"schema_version":1,"action":"allow_all","default":"deny"}`,
		`{"schema_version":1,"action":null}`,
		`{"schema_version":2,"default":"deny","rules":[],"action":"deny_all"}`,
		`{"schema_version":2,"default":"deny"}`,
		`{"schema_version":2,"default":null,"rules":[]}`,
		`{"schema_version":2,"default":"deny","rules":null}`,
		`{"schema_version":2,"default":"deny","rules":[],"note":1}`,
		`{"schema_version":2,"default":"permit","rules":[]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"permit"}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","protocol":"udp"}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["10.0.0.1/8"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["10.0.0.0/33"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["010.0.0.0/8"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["*.example.com"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["Example.com"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["localhost"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["example.com."]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["-bad.example.com"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["10.0.0.0/8"],"domains":["example.com"]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":[]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":null}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[0]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[65536]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[-1]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[1.5]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[{"from":90,"to":80}]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[{"from":0,"to":80}]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[{"from":80}]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[{"from":80,"to":90,"x":1}]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","ports":[]}]}`,
		`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":null}]}`,
	}
	for index, document := range invalid {
		var spec NetworkPolicySpec
		if err := json.Unmarshal([]byte(document), &spec); err == nil {
			t.Fatalf("invalid document %d accepted: %s", index, document)
		}
	}
	var oversized strings.Builder
	oversized.WriteString(`{"schema_version":2,"default":"deny","rules":[`)
	for i := 0; i < 129; i++ {
		if i > 0 {
			oversized.WriteString(",")
		}
		oversized.WriteString(`{"action":"deny"}`)
	}
	oversized.WriteString(`]}`)
	var spec NetworkPolicySpec
	if err := json.Unmarshal([]byte(oversized.String()), &spec); err == nil {
		t.Fatal("129 rules accepted")
	}
}

func TestNetworkPolicyPortRangeShapeChangesIdentity(t *testing.T) {
	var scalar, ranged NetworkPolicySpec
	if err := json.Unmarshal([]byte(`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[443]}]}`), &scalar); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[{"from":443,"to":443}]}]}`), &ranged); err != nil {
		t.Fatal(err)
	}
	left, _ := json.Marshal(scalar)
	right, _ := json.Marshal(ranged)
	if scalar.Equal(ranged) || strings.Contains(string(right), `"ports":[443]`) {
		t.Fatalf("range shape collapsed: %s vs %s", left, right)
	}
	leftRef, _ := scalar.Reference("org-1", "agent-1")
	rightRef, _ := ranged.Reference("org-1", "agent-1")
	if leftRef == rightRef {
		t.Fatal("scalar and range forms share one content identity")
	}
}

func TestNetworkPolicySpecReferenceIsContentAddressed(t *testing.T) {
	var spec NetworkPolicySpec
	if err := json.Unmarshal([]byte(testV2Spec), &spec); err != nil {
		t.Fatal(err)
	}
	first, err := spec.Reference("org-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := spec.Reference("org-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	canonical := `["org-1","agent-1",` + testV2Spec + `]`
	sum := sha256.Sum256([]byte(canonical))
	expectedID := "custom/" + hex.EncodeToString(sum[:])
	if first != second || first.Revision != 1 || first.PolicyID != expectedID {
		t.Fatalf("unstable reference: %+v want %s", first, expectedID)
	}
	for _, pair := range [][2]string{{"org-2", "agent-1"}, {"org-1", "agent-2"}} {
		other, err := spec.Reference(pair[0], pair[1])
		if err != nil {
			t.Fatal(err)
		}
		if other == first {
			t.Fatalf("scope changed but reference did not: %+v", other)
		}
	}
	var changed NetworkPolicySpec
	if err := json.Unmarshal(
		[]byte(`{"schema_version":2,"default":"allow","rules":[]}`), &changed,
	); err != nil {
		t.Fatal(err)
	}
	other, err := changed.Reference("org-1", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Fatal("spec change produced identical reference")
	}
	var invalid NetworkPolicySpec
	if _, err := invalid.Reference("org-1", "agent-1"); err == nil {
		t.Fatal("invalid spec produced a reference")
	}
}
