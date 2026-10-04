package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

// businessFixture supplies authenticated requests to existing business tests.
// Security tests call the embedded handler directly and sign independent claims;
// presentation headers must never establish trust at the production boundary.
type businessFixture struct {
	*handler
	t     *testing.T
	token string
	key   ed25519.PrivateKey
}

type fixtureTransport func(*http.Request) (*http.Response, error)

func (fn fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func newBusinessHandler(t *testing.T, cfg Config, deps Dependencies) *businessFixture {
	t.Helper()
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	digest := sha256.Sum256([]byte(token))
	callers, err := json.Marshal(map[string][]string{"edge-gateway": {"sha256:" + hex.EncodeToString(digest[:])}})
	if err != nil {
		t.Fatal(err)
	}
	deps.Authentication, err = serviceauth.ParseReceiver("admin-console", callers, false)
	if err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(map[string]any{"keys": []any{map[string]string{"kid": "fixture", "kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA", "x": base64.RawURLEncoding.EncodeToString(pub)}}})
	if err != nil {
		t.Fatal(err)
	}
	deps.CallerContext, err = callercontext.NewVerifier("http://identity.fixture", &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "identity.fixture" || r.URL.Path != "/rpc/identity/jwks" {
			t.Error("unexpected fixture JWKS request")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(jwks)))}, nil
	})}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(cfg, deps)
	if err != nil {
		t.Fatal(err)
	}
	return &businessFixture{handler: h.(*handler), t: t, token: token, key: key}
}

func (f *businessFixture) sign(actor principal.Principal, agent string, change func(map[string]any)) string {
	f.t.Helper()
	now := time.Now().Unix()
	claims := map[string]any{"iss": callercontext.Issuer, "sub": actor.UserID, "org": actor.OrganizationID, "mbr": actor.MembershipID, "sys_role": actor.SystemRole, "org_role": actor.OrganizationRole, "sid": "fixture-session", "aud": []string{"admin-console", "identity-service", "agent-controller", "agent-acp-service", "skill-registry"}, "iat": now, "exp": now + 60, "jti": "fixture-context"}
	if agent != "" {
		claims["agt"] = agent
	}
	if change != nil {
		change(claims)
	}
	header, err := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": "fixture"})
	if err != nil {
		f.t.Fatal(err)
	}
	body, err := json.Marshal(claims)
	if err != nil {
		f.t.Fatal(err)
	}
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.key, []byte(input)))
}

func (f *businessFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	*r = *r.Clone(r.Context())
	r.Header.Set(serviceauth.Header, "Bearer "+f.token)
	if actor, err := principal.FromHeaders(r.Header); err == nil {
		agent := ""
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 4 && parts[0] == "api" && parts[1] == "admin" && parts[2] == "agents" {
			agent = parts[3]
		}
		r.Header.Set(callercontext.Header, f.sign(actor, agent, nil))
	}
	f.handler.ServeHTTP(w, r)
}
