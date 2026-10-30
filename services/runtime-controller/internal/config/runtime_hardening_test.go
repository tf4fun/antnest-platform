package config

import (
	"strings"
	"testing"
)

func hardeningEnvironment(t *testing.T, values map[string]string) map[string]string {
	t.Helper()
	base := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
	}
	for key, value := range values {
		base[key] = value
	}
	return base
}

func TestLoadStopGraceDefaultsToTheRuntimeBudget(t *testing.T) {
	config, err := Load(testEnvironment(t, hardeningEnvironment(t, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if config.StopGraceSeconds != 20 {
		t.Fatalf("default stop grace = %d", config.StopGraceSeconds)
	}
}

func TestLoadStopGraceValidation(t *testing.T) {
	for _, test := range []struct {
		value string
		valid bool
		env   map[string]string
	}{
		{"20s", true, nil},
		{"120s", true, map[string]string{
			"ANTNEST_RUNTIME_MUTATION_TIMEOUT": "130s",
			"ANTNEST_RUNTIME_RPC_TIMEOUT":      "180s",
		}},
		{"45s", true, nil},
		{"19s", false, nil},
		{"121s", false, nil},
		{"0s", false, nil},
		{"1500ms", false, nil},
		{"20.5s", false, nil},
		{"bogus", false, nil},
	} {
		t.Run(test.value, func(t *testing.T) {
			env := hardeningEnvironment(t, map[string]string{
				"ANTNEST_RUNTIME_STOP_GRACE": test.value,
			})
			for key, value := range test.env {
				env[key] = value
			}
			_, err := Load(testEnvironment(t, env))
			if test.valid && err != nil {
				t.Fatalf("valid stop grace rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid stop grace accepted")
			}
		})
	}
}

func TestStopGraceFitsMutationBudget(t *testing.T) {
	for _, test := range []struct {
		name   string
		values map[string]string
		valid  bool
	}{
		{"defaults", map[string]string{}, true},
		{"grace120_mutation120", map[string]string{
			"ANTNEST_RUNTIME_STOP_GRACE": "120s",
		}, false},
		{"grace120_mutation130_rpc180", map[string]string{
			"ANTNEST_RUNTIME_STOP_GRACE":       "120s",
			"ANTNEST_RUNTIME_MUTATION_TIMEOUT": "130s",
			"ANTNEST_RUNTIME_RPC_TIMEOUT":      "180s",
		}, true},
		{"grace20_mutation25", map[string]string{
			"ANTNEST_RUNTIME_STOP_GRACE":       "20s",
			"ANTNEST_RUNTIME_MUTATION_TIMEOUT": "25s",
		}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, err := Load(testEnvironment(t, hardeningEnvironment(t, test.values)))
			if test.valid && err != nil {
				t.Fatalf("valid budget rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatalf("grace+stop must strictly fit inside the mutation timeout: %+v", config)
			}
		})
	}
}

func TestLoadWorkspaceQuotaBackendRequiresPairedConfiguration(t *testing.T) {
	for _, test := range []struct {
		name   string
		values map[string]string
		valid  bool
	}{
		{"unconfigured", map[string]string{}, true},
		{"paired", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "example-quota",
			"ANTNEST_RUNTIME_WORKSPACE_QUOTA_OPTION":  "size",
		}, true},
		{"driver_only", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "example-quota",
		}, false},
		{"option_only", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_QUOTA_OPTION": "size",
		}, false},
		{"local_driver", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "local",
			"ANTNEST_RUNTIME_WORKSPACE_QUOTA_OPTION":  "size",
		}, false},
		{"path_driver", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "/opt/evil",
			"ANTNEST_RUNTIME_WORKSPACE_QUOTA_OPTION":  "size",
		}, false},
		{"option_with_equals", map[string]string{
			"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "example-quota",
			"ANTNEST_RUNTIME_WORKSPACE_QUOTA_OPTION":  "size=1",
		}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, err := Load(testEnvironment(t, hardeningEnvironment(t, test.values)))
			if test.valid && err != nil {
				t.Fatalf("valid quota config rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid quota config accepted")
			}
			if err == nil && test.name == "paired" &&
				(config.WorkspaceVolumeDriver != "example-quota" || config.WorkspaceQuotaOption != "size") {
				t.Fatalf("quota backend not wired: %+v", config)
			}
		})
	}
}

func TestQuotaErrorNamesEnvironmentVariables(t *testing.T) {
	_, err := Load(testEnvironment(t, hardeningEnvironment(t, map[string]string{
		"ANTNEST_RUNTIME_WORKSPACE_VOLUME_DRIVER": "example-quota",
	})))
	if err == nil || !strings.Contains(err.Error(), "ANTNEST_RUNTIME_WORKSPACE") {
		t.Fatalf("quota pairing error must name the environment variables: %v", err)
	}
}
