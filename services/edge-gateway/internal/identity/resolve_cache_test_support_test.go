package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func cachedTestClient(t *testing.T, ttl time.Duration, size int, transport roundTripFunc) *Client {
	t.Helper()
	client, err := NewCachedClient(context.Background(), "http://identity.internal", &http.Client{Transport: transport}, ResolveCacheConfig{
		TTL: ttl, Size: size, RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func cacheTestSID(token string) string {
	digest := sha256.Sum256([]byte(token))
	return "session-" + hex.EncodeToString(digest[:])
}

// All deadlines originate inside the synctest bubble. Fixed-date fixtures for
// the direct client intentionally do not describe reusable current authority.
func cacheTestPayload(request *http.Request) map[string]any {
	var input map[string]string
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		panic(err)
	}
	now := time.Now()
	audiences := map[string][]string{
		"console":   {"admin-console", "identity-service", "agent-controller", "skill-registry", "agent-acp-service"},
		"workspace": {"agent-ui", "agent-acp-service", "agent-controller"},
		"acp":       {"agent-acp-service"},
		"session":   {"identity-service"},
	}
	claims := map[string]any{
		"iss": "antnest://service/identity-service", "sub": "user-1", "org": "org-1", "mbr": "member-1",
		"sys_role": "user", "org_role": "member", "sid": cacheTestSID(input["access_token"]),
		"aud": audiences[input["profile"]], "iat": now.Unix(), "exp": now.Unix() + 60, "jti": "cache-test-context",
	}
	if input["agent_id"] != "" {
		claims["agt"] = input["agent_id"]
	}
	return map[string]any{
		"principal": map[string]any{
			"user_id": "user-1", "organization_id": "org-1", "membership_id": "member-1",
			"organization_slug": "engineering", "organization_name": "Engineering",
			"system_role": "user", "organization_role": "member", "active": true,
		},
		"caller_context": cacheTestCCT(claims), "expires_at": now.Add(time.Hour),
		"idle_expires_at": now.Add(time.Minute), "activity_interval_ms": 1000,
	}
}

func cacheTestCCT(claims map[string]any) string {
	encoded, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}
	header := []byte(`{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"cache-test"}`)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(encoded)
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(unsigned)))
}

func cacheTestResponse(payload map[string]any) *http.Response {
	encoded, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return jsonResponse(http.StatusOK, string(encoded))
}

func cachePendingDelivery(client *Client, token, profile string) *resolveFlight {
	key := resolveKey{token: sha256.Sum256([]byte(token)), profile: profile}
	client.cache.mu.Lock()
	defer client.cache.mu.Unlock()
	flight := client.startResolveLocked(context.Background(), key, token, "", false)
	flight.waiters++
	client.cache.waiters++
	return flight
}
