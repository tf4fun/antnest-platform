package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

func testEnvironment(t *testing.T, values map[string]string) serviceauth.LookupEnv {
	t.Helper()
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	instanceKey := filepath.Join(dir, "instance-master")
	if err := os.WriteFile(instanceKey, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skill-registry"), []byte("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	result["ANTNEST_RUNTIME_INSTANCE_KEY_FILE"] = instanceKey
	result["ANTNEST_RUNTIME_EGRESS_URL"] = "http://runtime-egress:8081"
	if err := os.WriteFile(filepath.Join(dir, "runtime-egress"), []byte("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"), 0600); err != nil {
		t.Fatal(err)
	}
	for key, value := range values {
		result[key] = value
	}
	return func(name string) (string, bool) { value, present := result[name]; return value, present }
}
