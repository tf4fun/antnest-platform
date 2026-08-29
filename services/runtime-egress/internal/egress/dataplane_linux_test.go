//go:build linux

package egress

import (
	"net/netip"
	"strings"
	"testing"
)

func TestGatewayDenySetRunsBeforeConntrack(t *testing.T) {
	rules := gatewayNFTRules(netip.MustParsePrefix("100.96.0.0/16"), gatewayTUNName)
	raw := strings.Index(rules, "hook prerouting priority raw")
	deny := strings.Index(rules, "ip saddr @denied_sources counter drop")
	forward := strings.Index(rules, "hook forward priority filter")
	if raw < 0 || deny < raw || forward < deny {
		t.Fatalf("Gateway deny rule is not installed in pre-conntrack order:\n%s", rules)
	}
	input := strings.Index(rules, "hook input priority filter")
	localDrop := strings.Index(rules, `iifname "antnest-gw0" ip saddr 100.96.0.0/16 counter drop`)
	if input < 0 || localDrop < input {
		t.Fatalf("Gateway does not block TUN traffic addressed to the local host:\n%s", rules)
	}
	if strings.Count(rules, "counter") < 6 {
		t.Fatalf("Gateway policy lacks packet/byte evidence counters:\n%s", rules)
	}
}
