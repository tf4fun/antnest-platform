package config

import (
	"testing"
)

func TestProductionConfigRejectsAbsentAuthenticationAndUnsafeBindings(t *testing.T) {
	base := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://fixture/rc", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "fixture-management"}
	if _, err := Load(func(name string) (string, bool) { value, present := base[name]; return value, present }); err == nil {
		t.Fatal("unauthenticated production config was admitted")
	}
	for key, values := range map[string][]string{
		"ANTNEST_RUNTIME_CONTROLLER_LISTEN":        {":8080", "0.0.0.0:8080", "[::]:8080", "runtime-controller:8080", "224.0.0.1:8080", "127.0.0.1:0", "127.0.0.1:8082"},
		"ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN": {"0.0.0.0:8082", "172.18.0.2:8082", "[::]:8082", "127.0.0.1:8080"},
		"ANTNEST_RUNTIME_ALLOWED_IMAGES":           {"null", "{}", "[\"alpine:latest\"]", "[\"antnest/*\"]", "[1]", "[\"antnest/runtime\",\"docker.io/antnest/runtime\"]"},
	} {
		for _, value := range values {
			t.Run(key+value, func(t *testing.T) {
				input := map[string]string{}
				for k, v := range base {
					input[k] = v
				}
				input[key] = value
				if _, err := Load(testEnvironment(t, input)); err == nil {
					t.Fatal("unsafe or ambiguous operator configuration accepted")
				}
			})
		}
	}
}

func TestProductionImagePolicyAndLoopbackHealthAreOperatorOwned(t *testing.T) {
	env := testEnvironment(t, map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://fixture/rc", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "fixture-management", "ANTNEST_RUNTIME_CONTROLLER_LISTEN": "172.18.0.2:8120", "ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN": "127.0.0.1:8085", "ANTNEST_RUNTIME_ALLOWED_IMAGES": "[\"registry.example:5000/team/runtime\"]"})
	cfg, err := Load(env)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HealthListenAddress != "127.0.0.1:8085" || len(cfg.AllowedImages) != 1 || cfg.AllowedImages[0] != "registry.example:5000/team/runtime" {
		t.Fatal("operator boundary configuration was not retained")
	}
}
