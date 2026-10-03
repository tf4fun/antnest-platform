package serviceauth

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func testToken(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func outboundEnvironment(t *testing.T, service, token string) map[string]string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, service), []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	return map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir, "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers}
}

func lookupEnvironment(env map[string]string) LookupEnv {
	return func(name string) (string, bool) { value, ok := env[name]; return value, ok }
}

func TestOutboundReloadsEachRequestAndFailsClosedAfterReplacement(t *testing.T) {
	first, second := testToken(t), testToken(t)
	var headers []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = append(headers, r.Header.Get(Header))
		w.WriteHeader(204)
	}))
	defer upstream.Close()
	env := outboundEnvironment(t, "identity-service", first)
	clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	client := clients.HTTPClient()
	request := func() error {
		r, _ := http.NewRequest("GET", upstream.URL+"/rpc/identity/jwks", nil)
		r.Header.Set(Header, "Bearer forged")
		response, err := client.Do(r)
		if response != nil {
			_ = response.Body.Close()
		}
		return err
	}
	if err := request(); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(env["ANTNEST_SERVICE_AUTH_TOKEN_DIR"], "identity-service")
	if err := os.WriteFile(file+".next", []byte(second), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(file+".next", file); err != nil {
		t.Fatal(err)
	}
	if err := request(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(second+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if request() == nil {
		t.Fatal("malformed replacement used stale credentials")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if request() == nil {
		t.Fatal("missing replacement used stale credentials")
	}
	if len(headers) != 2 || headers[0] != "Bearer "+first || headers[1] != "Bearer "+second {
		t.Fatal("rotation did not authenticate each request independently")
	}
}

func TestOutboundPinsOriginsAndNeverFollowsRedirects(t *testing.T) {
	var leaked bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.WriteHeader(204) }))
	defer other.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	env := outboundEnvironment(t, "identity-service", testToken(t))
	clients, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer clients.CloseIdleConnections()
	response, err := clients.HTTPClient().Get(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 307 || leaked {
		t.Fatal("service credential followed a redirect")
	}
	if response, err := clients.HTTPClient().Get(other.URL); err == nil {
		_ = response.Body.Close()
		t.Fatal("unconfigured receiver origin was allowed")
	}
}

func TestOutboundStartupRejectsIncompleteOrRepairedCredentials(t *testing.T) {
	for _, mutate := range []func(map[string]string){
		func(e map[string]string) { delete(e, "ANTNEST_SERVICE_AUTH_MODE") },
		func(e map[string]string) { e["ANTNEST_SERVICE_AUTH_MODE"] = " token" },
		func(e map[string]string) { e["ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT"] = "" },
		func(e map[string]string) { e["ANTNEST_SERVICE_AUTH_MODE"] = "mtls" },
		func(e map[string]string) { e["ANTNEST_SERVICE_AUTH_TOKEN_DIR"] = "" },
		func(e map[string]string) { e["ANTNEST_TLS_CA_FILE"] = "partial" },
		func(e map[string]string) { delete(e, "ANTNEST_SERVICE_AUTH_CALLERS_FILE") },
	} {
		env := outboundEnvironment(t, "identity-service", testToken(t))
		mutate(env)
		if _, err := LoadOutbound(lookupEnvironment(env), map[string]string{"identity-service": "http://identity.internal"}); err == nil {
			t.Fatal("invalid startup configuration was accepted")
		}
	}
}
