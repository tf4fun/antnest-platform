package credentials

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

const tokenEntropyBytes = 32

func NewOpaqueToken(prefix string) (string, string, error) {
	buffer := make([]byte, tokenEntropyBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", "", fmt.Errorf("generate opaque token: %w", err)
	}
	raw := prefix + base64.RawURLEncoding.EncodeToString(buffer)
	return raw, HashToken(raw), nil
}

func HashToken(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}
