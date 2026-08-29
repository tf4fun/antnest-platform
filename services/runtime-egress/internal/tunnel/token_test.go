package tunnel

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

func TestTokenVerifierAcceptsSignedLiveClaims(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	verifier, err := NewTokenVerifier(secret)
	if err != nil {
		t.Fatalf("NewTokenVerifier() error = %v", err)
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	verifier.now = func() time.Time { return now }
	claims := protocol.TunnelClaims{
		Version: 1,
		Reservation: protocol.Reservation{
			GenerationKey: protocol.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2},
			AgentID:       "agent-1", VirtualIP: netip.MustParseAddr("100.64.0.2"),
			AllocatorEpoch: 1, NetworkMode: protocol.NetworkUnrestricted,
			PolicyEpoch: 3, PolicyRevision: 3,
		},
		RuntimeBootID: "boot-1", ConnectionEpoch: 4,
		ExpiresAtUnixMilli: now.Add(time.Minute).UnixMilli(),
	}
	token := signToken(t, secret, claims)
	got, err := verifier.Verify(token)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if got.Reservation.RuntimeInstanceID != claims.Reservation.RuntimeInstanceID || got.ConnectionEpoch != 4 {
		t.Fatalf("Verify() = %+v", got)
	}
}

func TestTokenVerifierRejectsTampering(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	verifier, _ := NewTokenVerifier(secret)
	if _, err := verifier.Verify("e30.invalid"); err == nil {
		t.Fatal("Verify() error = nil, want signature failure")
	}
}

func signToken(t *testing.T, secret []byte, claims protocol.TunnelClaims) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(payloadPart))
	return payloadPart + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
