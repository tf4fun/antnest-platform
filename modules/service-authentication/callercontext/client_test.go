package callercontext

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func testIssuer(t *testing.T, kid string) (string, []byte) {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	claims, _ := json.Marshal(map[string]any{"iss": Issuer, "sub": "user-admin", "org": "org-1", "mbr": "membership-1", "sys_role": "admin", "org_role": "admin", "sid": "session-1", "aud": []string{"admin-console"}, "iat": now, "exp": now + 60, "jti": "context-1"})
	header, _ := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": kid})
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	token := input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(input)))
	jwks, _ := json.Marshal(map[string]any{"keys": []any{map[string]string{"kid": kid, "kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA", "x": base64.RawURLEncoding.EncodeToString(pub)}}})
	return token, jwks
}

func TestVerifierCachesBoundedTrustAndRefreshesUnknownKeyOnce(t *testing.T) {
	current, currentJWKS := testIssuer(t, "current")
	next, nextJWKS := testIssuer(t, "next")
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "identity.internal" || r.URL.Path != "/rpc/identity/jwks" {
			t.Error("JWKS escaped pinned Identity endpoint")
		}
		payload := currentJWKS
		if calls.Add(1) > 1 {
			payload = nextJWKS
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(payload)))}, nil
	})}
	verifier, err := NewVerifier("http://identity.internal", client, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := verifier.Verify(context.Background(), current, Expected{Consumer: "admin-console"}); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("known key triggered redundant refresh")
	}
	if _, err := verifier.Verify(context.Background(), next, Expected{Consumer: "admin-console"}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("next key did not refresh exactly once")
	}
	for range 3 {
		if _, err := verifier.Verify(context.Background(), current, Expected{Consumer: "admin-console"}); err == nil {
			t.Fatal("removed key was accepted")
		}
	}
	if calls.Load() != 2 {
		t.Fatal("unknown keys bypassed refresh throttle")
	}
}

func TestVerifierNeverUsesExpiredTrustWhenIdentityIsUnavailable(t *testing.T) {
	token, jwks := testIssuer(t, "current")
	fail := false
	verifier, err := NewVerifier("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		if fail {
			return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(jwks)))}, nil
	})}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(context.Background(), token, Expected{Consumer: "admin-console"}); err != nil {
		t.Fatal(err)
	}
	fail = true
	verifier.expiresAt = time.Now().Add(-time.Second)
	if _, err := verifier.Verify(context.Background(), token, Expected{Consumer: "admin-console"}); err != ErrDependency {
		t.Fatal("expired keys survived a dependency outage")
	}
}
