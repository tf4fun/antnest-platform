package credentials

import (
	"strings"
	"testing"
)

func TestOpaqueTokenGenerationAndHashing(t *testing.T) {
	t.Parallel()

	raw, digest, err := NewOpaqueToken("ant_api_")
	if err != nil {
		t.Fatalf("new token: %v", err)
	}
	if !strings.HasPrefix(raw, "ant_api_") || len(raw) < 40 {
		t.Fatalf("raw token has unexpected format: %q", raw)
	}
	if digest != HashToken(raw) {
		t.Fatal("stored digest does not match token hash")
	}
	if strings.Contains(digest, raw) || len(digest) != 64 {
		t.Fatalf("digest is not a fixed SHA-256 hex value: %q", digest)
	}

	other, otherDigest, err := NewOpaqueToken("ant_api_")
	if err != nil {
		t.Fatalf("new second token: %v", err)
	}
	if raw == other || digest == otherDigest {
		t.Fatal("opaque token generator repeated a credential")
	}
}
