package tunnel

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-egress/internal/protocol"
)

type TokenVerifier struct {
	secret []byte
	now    func() time.Time
}

func NewTokenVerifier(secret []byte) (*TokenVerifier, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("egress token secret must contain at least 32 bytes")
	}
	return &TokenVerifier{
		secret: append([]byte(nil), secret...),
		now:    func() time.Time { return time.Now().UTC() },
	}, nil
}

func (v *TokenVerifier) Verify(raw string) (protocol.TunnelClaims, error) {
	payloadPart, signaturePart, ok := strings.Cut(strings.TrimSpace(raw), ".")
	if !ok || payloadPart == "" || signaturePart == "" || strings.Contains(signaturePart, ".") {
		return protocol.TunnelClaims{}, fmt.Errorf("egress token shape is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadPart)
	if err != nil {
		return protocol.TunnelClaims{}, fmt.Errorf("decode egress token payload: %w", err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(signaturePart)
	if err != nil {
		return protocol.TunnelClaims{}, fmt.Errorf("decode egress token signature: %w", err)
	}
	mac := hmac.New(sha256.New, v.secret)
	_, _ = mac.Write([]byte(payloadPart))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return protocol.TunnelClaims{}, fmt.Errorf("egress token signature is invalid")
	}
	var claims protocol.TunnelClaims
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return protocol.TunnelClaims{}, fmt.Errorf("decode egress token claims: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("egress token contains trailing JSON")
		}
		return protocol.TunnelClaims{}, err
	}
	if err := claims.Validate(v.now()); err != nil {
		return protocol.TunnelClaims{}, err
	}
	return claims, nil
}
