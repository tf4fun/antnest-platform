package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

// The Node component gate validates the actual platform-bound output below
// against RuntimeSpec, rather than a hand-written copy of the Go wire shape.
func TestGeneratedMaintenanceRuntimeSpecs(t *testing.T) {
	encoded, err := os.ReadFile("../../../../contracts/runtime/maintenance-kid-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Valid []string `json:"valid"`
	}
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	cases := [][]string{{}, {"next_2026-02", "key_2026-01"}}
	for _, kid := range fixtures.Valid {
		cases = append(cases, []string{kid})
	}
	for _, kids := range cases {
		keys := deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{}}
		for _, kid := range kids {
			keys.Keys = append(keys.Keys, deployment.MaintenanceVerifierKey{
				KID: kid, Algorithm: "Ed25519", PublicKeyBase64URL: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			})
		}
		bootstrap, err := json.Marshal(keys)
		if err != nil {
			t.Fatal(err)
		}
		values := map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":     "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":          "fixture-management",
			"ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS": string(bootstrap),
		}
		callers := filepath.Join(t.TempDir(), "callers.json")
		if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		values["ANTNEST_SERVICE_AUTH_MODE"] = "token"
		values["ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT"] = "true"
		values["ANTNEST_SERVICE_AUTH_CALLERS_FILE"] = callers
		master := filepath.Join(t.TempDir(), "instance-master")
		if err := os.WriteFile(master, make([]byte, 32), 0600); err != nil {
			t.Fatal(err)
		}
		values["ANTNEST_RUNTIME_INSTANCE_KEY_FILE"] = master
		loaded, err := config.Load(func(key string) (string, bool) { value, present := values[key]; return value, present })
		if err != nil {
			t.Fatal(err)
		}
		driver := newLifecyclePlatform()
		service := newLifecycleService(t, newLifecycleRepository(), driver)
		if err := service.SetMaintenanceVerifiers(loaded.MaintenanceVerifiers); err != nil {
			t.Fatal(err)
		}
		operation, err := service.InitializeRuntime(context.Background(), "fixture-request", "agent-1", lifecycleConfiguration())
		if err != nil || operation.State != deployment.OperationCompleted || len(driver.deployments) != 1 {
			t.Fatalf("configured runtime was not built: %+v %v", operation, err)
		}
		spec, err := json.Marshal(driver.deployments[0].RuntimeSpec)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("MAINTENANCE_RUNTIME_SPEC:%s", spec)
	}
}
