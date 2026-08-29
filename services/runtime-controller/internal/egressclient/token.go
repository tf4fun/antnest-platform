package egressclient

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/runtimeconn"
)

type TokenIssuer struct {
	secret []byte
	now    func() time.Time
	ttl    time.Duration
}

func NewTokenIssuer(secret []byte) (*TokenIssuer, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("egress token secret must contain at least 32 bytes")
	}
	return &TokenIssuer{
		secret: append([]byte(nil), secret...),
		now:    func() time.Time { return time.Now().UTC() },
		ttl:    30 * time.Second,
	}, nil
}

func (i *TokenIssuer) Issue(input runtimeconn.EgressTokenInput) (string, time.Time, error) {
	if strings.TrimSpace(input.AgentID) == "" || strings.TrimSpace(input.RuntimeInstanceID) == "" ||
		input.Generation == 0 || strings.TrimSpace(input.RuntimeBootID) == "" || input.ConnectionEpoch == 0 ||
		!input.VirtualIP.Is4() || input.VirtualIP.IsUnspecified() || input.AllocatorEpoch == 0 ||
		input.PolicyEpoch == 0 || input.PolicyRevision == 0 {
		return "", time.Time{}, fmt.Errorf("complete egress token identity is required")
	}
	expiresAt := i.now().UTC().Add(i.ttl)
	claims := tokenClaims{
		Version: 1,
		Reservation: tokenReservation{
			RuntimeInstanceID: input.RuntimeInstanceID, Generation: input.Generation,
			AgentID: input.AgentID, VirtualIP: input.VirtualIP.String(),
			AllocatorEpoch: input.AllocatorEpoch, NetworkMode: "unrestricted",
			PolicyEpoch: input.PolicyEpoch, PolicyRevision: input.PolicyRevision,
		},
		RuntimeBootID: input.RuntimeBootID, ConnectionEpoch: input.ConnectionEpoch,
		ExpiresAtUnixMilli: expiresAt.UnixMilli(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("encode egress token: %w", err)
	}
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, i.secret)
	_, _ = mac.Write([]byte(payloadPart))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payloadPart + "." + signature, expiresAt, nil
}

type tokenClaims struct {
	Version            int              `json:"version"`
	Reservation        tokenReservation `json:"reservation"`
	RuntimeBootID      string           `json:"runtime_boot_id"`
	ConnectionEpoch    uint64           `json:"connection_epoch"`
	ExpiresAtUnixMilli int64            `json:"expires_at_unix_ms"`
}

type tokenReservation struct {
	RuntimeInstanceID string `json:"runtime_instance_id"`
	Generation        uint64 `json:"generation"`
	AgentID           string `json:"agent_id"`
	VirtualIP         string `json:"virtual_ip"`
	AllocatorEpoch    uint64 `json:"allocator_epoch"`
	NetworkMode       string `json:"network_mode"`
	PolicyEpoch       uint64 `json:"policy_epoch"`
	PolicyRevision    uint64 `json:"policy_revision"`
}
