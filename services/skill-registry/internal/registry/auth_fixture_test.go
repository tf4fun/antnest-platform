package registry

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/serviceauth"
)

type handlerFixture struct {
	*Handler
	tokens map[string]string
	key    ed25519.PrivateKey
}

func randomToken(t *testing.T) string {
	t.Helper()
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func newTestHandler(t *testing.T, service *Service, discovery ...*Discovery) *handlerFixture {
	t.Helper()
	f := &handlerFixture{tokens: map[string]string{}}
	hashes := map[string][]string{}
	for _, caller := range serviceauth.Services {
		if caller == "skill-registry" {
			continue
		}
		token := randomToken(t)
		f.tokens[caller] = token
		digest := sha256.Sum256([]byte(token))
		hashes[caller] = []string{"sha256:" + hex.EncodeToString(digest[:])}
	}
	raw, _ := json.Marshal(hashes)
	receiver, err := serviceauth.ParseReceiver("skill-registry", raw, false)
	if err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.key = key
	jwks, _ := json.Marshal(map[string]any{"keys": []any{map[string]string{"kid": "fixture", "kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA", "x": base64.RawURLEncoding.EncodeToString(pub)}}})
	verifier, err := callercontext.NewVerifier("http://identity.invalid", &http.Client{Transport: sourceRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(jwks)))}, nil
	})}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	f.Handler, err = NewHandler(service, Security{Authentication: receiver, CallerContext: verifier}, nil, discovery...)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *handlerFixture) contextToken(extra map[string]any) string {
	now := time.Now().Unix()
	claims := map[string]any{"iss": callercontext.Issuer, "sub": testActor, "org": testOrg, "mbr": "membership-fixture", "sys_role": "admin", "org_role": "admin", "sid": "session-fixture", "aud": []string{"skill-registry"}, "iat": now, "exp": now + 60, "jti": "context-fixture"}
	for name, value := range extra {
		claims[name] = value
	}
	header, _ := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": "fixture"})
	body, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.key, []byte(input)))
}

func (f *handlerFixture) Authorize(r *http.Request, caller string) *http.Request {
	r.Header.Del("Authorization")
	r.Header.Del(callercontext.Header)
	r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
	if caller == "admin-console" {
		r.Header.Set(callercontext.Header, f.contextToken(nil))
	}
	return r
}

func (f *handlerFixture) Authenticate(r *http.Request) *http.Request {
	caller := "admin-console"
	if r.URL.Path == "/internal/skill-versions/resolve" {
		caller = "agent-controller"
	}
	if r.URL.Path == "/internal/skill-projections" {
		caller = "agent-acp-service"
	}
	return f.Authorize(r, caller)
}

func newTestSource(t *testing.T, origin, token string) (*HTTPAgentSource, error) {
	t.Helper()
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-acp-service"), []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	clients, err := serviceauth.LoadOutbound(func(k string) (string, bool) { v, p := env[k]; return v, p }, map[string]string{"agent-acp-service": origin})
	if err != nil {
		return nil, err
	}
	t.Cleanup(clients.CloseIdleConnections)
	return NewHTTPAgentSource(origin, clients.HTTPClient())
}
