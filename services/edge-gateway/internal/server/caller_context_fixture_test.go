package server

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// This trusted issuer double preserves real CCT framing; downstream signature
// verification is covered in its owning-service batch.
func testIssuerContext(t *testing.T) string {
	t.Helper()
	now := time.Now().Unix()
	body, _ := json.Marshal(map[string]any{"sid": "token-1", "iat": now, "exp": now + 60})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test"}`)) + "." + base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 64))
}
