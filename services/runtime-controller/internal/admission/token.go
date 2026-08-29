package admission

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

type Issuer struct {
	secret []byte
}

func NewIssuer(secret []byte) (*Issuer, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("runtime token secret must contain at least 32 bytes")
	}
	copyOfSecret := append([]byte(nil), secret...)
	return &Issuer{secret: copyOfSecret}, nil
}

func (i *Issuer) Token(agentID string, generation uint64) (string, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || generation == 0 {
		return "", fmt.Errorf("agent id and positive generation are required")
	}
	mac := hmac.New(sha256.New, i.secret)
	_, _ = mac.Write([]byte("antnest-runtime-v1\x00"))
	_, _ = mac.Write([]byte(agentID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(strconv.FormatUint(generation, 10)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (i *Issuer) Verify(agentID string, generation uint64, candidate string) bool {
	expected, err := i.Token(agentID, generation)
	if err != nil {
		return false
	}
	return hmac.Equal([]byte(expected), []byte(strings.TrimSpace(candidate)))
}

func InstanceID(agentID string, generation uint64) string {
	return domain.RuntimeInstanceID(agentID, generation)
}
