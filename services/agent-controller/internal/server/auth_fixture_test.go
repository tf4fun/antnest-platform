package server

import (
	"bytes"
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

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
)

// Test-only signing at the business fixture preserves existing domain tests.
// Admission tests call raw directly: raw headers never authenticate production.
type businessFixture struct {
	raw      http.Handler
	security Security
	t        *testing.T
	tokens   map[string]string
	key      ed25519.PrivateKey
}

type fixtureTransport func(*http.Request) (*http.Response, error)

func (fn fixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func newAuthenticationFixture(t *testing.T) *businessFixture {
	t.Helper()
	tokens, hashes := map[string]string{}, map[string][]string{}
	for _, caller := range serviceauth.Services {
		if caller == "agent-controller" {
			continue
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		token := base64.RawURLEncoding.EncodeToString(raw)
		digest := sha256.Sum256([]byte(token))
		tokens[caller] = token
		hashes[caller] = []string{"sha256:" + hex.EncodeToString(digest[:])}
	}
	raw, err := json.Marshal(hashes)
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := serviceauth.ParseReceiver("agent-controller", raw, false)
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
	verifier, err := callercontext.NewVerifier("http://identity.fixture", &http.Client{Transport: fixtureTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "identity.fixture" || r.URL.Path != "/rpc/identity/jwks" {
			t.Error("unexpected fixture key request")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(jwks))}, nil
	})}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return &businessFixture{t: t, tokens: tokens, key: key, security: Security{Authentication: receiver, CallerContext: verifier}}
}

func newBusinessHandler(t *testing.T, catalog CatalogService, lifecycle LifecycleService, configuration AgentConfigurationService,
	queries AgentQueryService, events AgentEventService, network NetworkPolicyService, health HealthCheck) (http.Handler, error) {
	f := newAuthenticationFixture(t)
	var err error
	f.raw, err = NewHandler(catalog, lifecycle, configuration, queries, events, network, health, f.security)
	if err != nil {
		return nil, err
	}
	return f, nil
}

func withBusinessLearningRoutes(t *testing.T, base http.Handler, service SkillLearningPolicyService) (http.Handler, error) {
	f := newAuthenticationFixture(t)
	if previous, ok := base.(*businessFixture); ok {
		f = previous
		base = previous.raw
	}
	raw, err := WithSkillLearningPolicyRoutes(base, service, f.security)
	if err != nil {
		return nil, err
	}
	f.raw = raw
	return f, nil
}

func (f *businessFixture) sign(overrides map[string]any) string {
	f.t.Helper()
	now := time.Now().Unix()
	claims := map[string]any{"iss": callercontext.Issuer, "sub": "user-admin", "org": "org-1", "mbr": "member-1", "sys_role": "user", "org_role": "admin", "sid": "session-1", "aud": []string{"agent-controller", "admin-console", "agent-ui"}, "iat": now, "exp": now + 60, "jti": "fixture-context"}
	for key, value := range overrides {
		claims[key] = value
	}
	header, _ := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": "fixture"})
	body, err := json.Marshal(claims)
	if err != nil {
		f.t.Fatal(err)
	}
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.key, []byte(input)))
}

func (f *businessFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	original := r
	defer func() { original.Pattern = r.Pattern }()
	r = r.Clone(r.Context())
	caller := "admin-console"
	if r.URL.Path == "/rpc/agent-controller/list-workspace-agents" {
		caller = "agent-ui"
	} else if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/skill-learning-policy") {
		caller = "agent-acp-service"
	}
	claims := map[string]any{}
	for key, claim := range map[string]string{"organization_id": "org", "principal_id": "sub"} {
		if value := strings.TrimSpace(r.URL.Query().Get(key)); value != "" {
			claims[claim] = value
		}
	}
	if r.Body != nil {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			f.t.Fatal(err)
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var object map[string]json.RawMessage
		if json.Unmarshal(body, &object) == nil {
			for key, claim := range map[string]string{"organization_id": "org", "actor_principal_id": "sub", "principal_id": "sub", "agent_id": "agt"} {
				if value, ok := objectString(object, key); ok && strings.TrimSpace(value) != "" {
					claims[claim] = strings.TrimSpace(value)
				}
			}
		}
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "internal" && parts[1] == "agents" {
		claims["agt"] = parts[2]
	}
	if _, ok := claims["sub"]; !ok {
		claims["sub"] = "user-admin"
	}
	r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
	r.Header.Set(callercontext.Header, f.sign(claims))
	if (r.Method == "POST" || r.Method == "PUT") && r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", "application/json")
	}
	f.raw.ServeHTTP(w, r)
}
