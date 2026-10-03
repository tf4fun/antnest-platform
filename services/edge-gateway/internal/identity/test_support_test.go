package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func testIssuerContext(t *testing.T) string {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	claims, _ := json.Marshal(map[string]any{"iss": "antnest://service/identity-service", "sub": "user-1", "org": "org-1", "mbr": "member-1", "sys_role": "user", "org_role": "member", "sid": "session-1", "aud": []string{"agent-ui", "agent-acp-service", "agent-controller"}, "iat": now, "exp": now + 60, "jti": "test-context"})
	header := []byte(`{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test-issuer"}`)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(unsigned)))
}
