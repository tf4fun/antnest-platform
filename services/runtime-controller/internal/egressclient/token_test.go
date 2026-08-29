package egressclient

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"net/netip"

	"soft/antnest-platform/services/runtime-controller/internal/runtimeconn"
)

func TestTokenIssuerBindsGenerationAndPolicy(t *testing.T) {
	issuer, err := NewTokenIssuer([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("NewTokenIssuer() error = %v", err)
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	issuer.now = func() time.Time { return now }
	token, expiresAt, err := issuer.Issue(runtimeconn.EgressTokenInput{
		AgentID: "agent-1", RuntimeInstanceID: "runtime-1", Generation: 2,
		RuntimeBootID: "boot-1", ConnectionEpoch: 3,
		VirtualIP: netip.MustParseAddr("100.64.0.2"), AllocatorEpoch: 1,
		PolicyEpoch: 4, PolicyRevision: 4,
	})
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	payloadPart, _, ok := strings.Cut(token, ".")
	if !ok {
		t.Fatalf("Issue() token = %q", token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		t.Fatalf("DecodeString() error = %v", err)
	}
	var claims tokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if claims.Reservation.Generation != 2 || claims.Reservation.PolicyEpoch != 4 ||
		expiresAt != now.Add(30*time.Second) {
		t.Fatalf("unexpected claims=%+v expires=%v", claims, expiresAt)
	}
}
