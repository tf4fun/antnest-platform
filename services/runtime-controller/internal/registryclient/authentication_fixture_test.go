package registryclient

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
)

const registryTestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

func newAuthenticatedRegistry(t *testing.T, origin string) (*Client, error) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "callers.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "skill-registry"), []byte(registryTestToken), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": filepath.Join(dir, "callers.json"), "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	auth, err := serviceauth.LoadOutbound(func(key string) (string, bool) { value, present := env[key]; return value, present }, map[string]string{"skill-registry": origin})
	if err != nil {
		return nil, err
	}
	t.Cleanup(auth.CloseIdleConnections)
	return New(origin, time.Second, auth)
}
