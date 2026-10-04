package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
)

func testEnvironment(t *testing.T, values map[string]string) serviceauth.LookupEnv {
	t.Helper()
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skill-registry"), []byte("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	for key, value := range values {
		result[key] = value
	}
	return func(name string) (string, bool) { value, present := result[name]; return value, present }
}
