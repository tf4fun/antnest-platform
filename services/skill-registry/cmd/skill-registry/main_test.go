package main

import (
	"crypto/rand"
	"encoding/base64"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"os"
	"path/filepath"
	"testing"
)

func configFixture(t *testing.T) map[string]string {
	t.Helper()
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"identity-service", "agent-acp-service"} {
		data := make([]byte, 32)
		if _, err := rand.Read(data); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(base64.RawURLEncoding.EncodeToString(data)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return map[string]string{"ANTNEST_SKILL_REGISTRY_DATABASE_URL": "postgres://registry@example/registry", "ANTNEST_IDENTITY_URL": "http://identity.invalid", "ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
}
func envLookup(values map[string]string) serviceauth.LookupEnv {
	return func(key string) (string, bool) { v, p := values[key]; return v, p }
}
func TestLoadConfig(t *testing.T) {
	values := configFixture(t)
	cfg, err := loadConfig(envLookup(values))
	if err != nil || cfg.listenAddress != ":8080" {
		t.Fatalf("configuration rejected: %v", err)
	}
	cfg.clients.CloseIdleConnections()
	for _, name := range []string{"ANTNEST_SERVICE_AUTH_MODE", "ANTNEST_SERVICE_AUTH_CALLERS_FILE", "ANTNEST_SERVICE_AUTH_TOKEN_DIR", "ANTNEST_IDENTITY_URL"} {
		v := values[name]
		delete(values, name)
		if cfg, err := loadConfig(envLookup(values)); err == nil {
			cfg.clients.CloseIdleConnections()
			t.Fatalf("accepted missing %s", name)
		}
		values[name] = v
	}
	for _, name := range []string{"ANTNEST_SKILL_REGISTRY_API_TOKEN", "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN"} {
		values[name] = "old-credential"
		if cfg, err := loadConfig(envLookup(values)); err == nil {
			cfg.clients.CloseIdleConnections()
			t.Fatal("accepted legacy credential fallback")
		}
		delete(values, name)
	}
}

func TestHealthProbeAddress(t *testing.T) {
	for _, fixture := range []struct{ input, expected string }{
		{"", "127.0.0.1:8080"},
		{":8123", "127.0.0.1:8123"},
		{"0.0.0.0:8123", "127.0.0.1:8123"},
		{"[::]:8123", "127.0.0.1:8123"},
		{" 127.0.0.2:8123 ", "127.0.0.2:8123"},
		{"10.241.255.50:8080", "10.241.255.50:8080"},
		{"[::1]:8123", "[::1]:8123"},
		{"[fd00::5]:8123", "[fd00::5]:8123"},
		{"skill-registry:8080", "skill-registry:8080"},
	} {
		t.Run(fixture.input, func(t *testing.T) {
			actual, err := healthProbeAddress(fixture.input)
			if err != nil || actual != fixture.expected {
				t.Fatalf("address = %q, error = %v; want %q", actual, err, fixture.expected)
			}
		})
	}
	for _, input := range []string{"127.0.0.1", "::1:8080", "[::1]"} {
		if _, err := healthProbeAddress(input); err == nil {
			t.Fatalf("malformed address %q was accepted", input)
		}
	}
}
