package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type consoleAuthFixture struct {
	token  string
	key    ed25519.PrivateKey
	values map[string]string
}

func newConsoleAuthFixture(t *testing.T, upstreamURL string) *consoleAuthFixture {
	t.Helper()
	randomToken := func() string {
		t.Helper()
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	f := &consoleAuthFixture{token: randomToken(), values: map[string]string{}}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.key = key
	jwks, err := json.Marshal(map[string]any{"keys": []any{map[string]string{"kid": "shutdown", "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "x": base64.RawURLEncoding.EncodeToString(pub)}}})
	if err != nil {
		t.Fatal(err)
	}
	keys, err := callercontext.ParseKeys(jwks)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	outgoing := filepath.Join(dir, "outgoing")
	if err := os.Mkdir(outgoing, 0700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(f.token))
	callers, err := json.Marshal(map[string][]string{"edge-gateway": {"sha256:" + hex.EncodeToString(digest[:])}})
	if err != nil {
		t.Fatal(err)
	}
	callersFile := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callersFile, callers, 0600); err != nil {
		t.Fatal(err)
	}
	f.values["ANTNEST_SERVICE_AUTH_MODE"] = "token"
	f.values["ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT"] = "true"
	f.values["ANTNEST_SERVICE_AUTH_CALLERS_FILE"] = callersFile
	f.values["ANTNEST_SERVICE_AUTH_TOKEN_DIR"] = outgoing
	backend, err := url.Parse(upstreamURL)
	if err != nil {
		t.Fatal(err)
	}
	for name, variable := range map[string]string{"identity-service": "ANTNEST_IDENTITY_SERVICE_URL", "agent-controller": "ANTNEST_AGENT_CONTROLLER_URL", "agent-acp-service": "ANTNEST_AGENT_ACP_SERVICE_URL"} {
		token := randomToken()
		if err := os.WriteFile(filepath.Join(outgoing, name), []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
		proxy := httputil.NewSingleHostReverseProxy(backend)
		transport := http.DefaultTransport.(*http.Transport).Clone()
		proxy.Transport = transport
		t.Cleanup(transport.CloseIdleConnections)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(serviceauth.Header) != "Bearer "+token {
				t.Error("Console dependency request was not authenticated")
				w.WriteHeader(401)
				return
			}
			if name == "identity-service" && r.URL.Path == "/rpc/identity/jwks" {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(jwks)
				return
			}
			var agent *string
			parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			if len(parts) >= 3 && parts[0] == "internal" && parts[1] == "agents" {
				agent = &parts[2]
			}
			claims, err := callercontext.Verify(r.Header.Get(callercontext.Header), keys, callercontext.Expected{Consumer: name, Agent: agent, Now: time.Now(), Tolerance: 30})
			if err != nil || claims.Subject != "user-admin" || claims.Organization != "org-1" {
				t.Error("Console dependency request lost its signed actor")
				w.WriteHeader(401)
				return
			}
			proxy.ServeHTTP(w, r)
		}))
		t.Cleanup(server.Close)
		f.values[variable] = server.URL
	}
	return f
}

func (f *consoleAuthFixture) request(rawURL string) (*http.Response, error) {
	r, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	claims := map[string]any{"iss": callercontext.Issuer, "sub": "user-admin", "org": "org-1", "mbr": "member-1", "sys_role": "admin", "org_role": "admin", "sid": "test-session", "aud": []string{"admin-console", "identity-service", "agent-controller", "agent-acp-service", "skill-registry"}, "iat": now, "exp": now + 60, "jti": "test-context"}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) >= 4 && parts[0] == "api" && parts[1] == "admin" && parts[2] == "agents" {
		claims["agt"] = parts[3]
	}
	header, err := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": "shutdown"})
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(claims)
	if err != nil {
		return nil, err
	}
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	r.Header.Set(serviceauth.Header, "Bearer "+f.token)
	r.Header.Set(callercontext.Header, input+"."+base64.RawURLEncoding.EncodeToString(ed25519.Sign(f.key, []byte(input))))
	return (&http.Client{Timeout: 4 * time.Second}).Do(r)
}
