package config

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func authenticationEnvironment(t *testing.T) map[string]string {
	t.Helper()
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	tokens := filepath.Join(dir, "tokens")
	if err := os.Mkdir(tokens, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, receiver := range []string{"identity-service", "agent-acp-service", "runtime-controller", "runtime-egress", "skill-registry"} {
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(tokens, receiver), []byte(base64.RawURLEncoding.EncodeToString(secret)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": tokens}
}

func loadBusinessConfig(t *testing.T, lookup func(string) string) (Config, error) {
	t.Helper()
	security := authenticationEnvironment(t)
	loaded, err := Load(func(key string) (string, bool) {
		if value, present := security[key]; present {
			return value, true
		}
		value := lookup(key)
		return value, value != ""
	})
	if loaded.Authentication != nil {
		t.Cleanup(loaded.Authentication.CloseIdleConnections)
	}
	return loaded, err
}
