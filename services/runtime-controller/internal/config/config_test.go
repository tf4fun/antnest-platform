package config

import (
	"testing"
	"time"
)

func TestLoadUsesThinDockerAdapterDefaults(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.ListenAddress != ":8080" || config.Platform != "docker" ||
		config.DockerSocketPath != "/var/run/docker.sock" {
		t.Fatalf("unexpected platform defaults: %+v", config)
	}
	if config.RuntimeStatusTimeout != 5*time.Second || config.MutationTimeout != 2*time.Minute ||
		config.ObservationRetention != 7*24*time.Hour || config.RPCRequestTimeout != 3*time.Minute ||
		config.ReconciliationTimeout != 2*time.Minute {
		t.Fatalf("unexpected bounded-operation defaults: %+v", config)
	}
	if config.SystemSkillsVolume != "antnest-system-skills" {
		t.Fatalf("unexpected system Skills volume: %s", config.SystemSkillsVolume)
	}
	if config.LegacyBackupRoot != "/legacy-skill-backups" {
		t.Fatalf("unexpected legacy backup root: %s", config.LegacyBackupRoot)
	}
	if config.ControllerScope != "antnest-runtime-management" {
		t.Fatalf("controller scope did not default to the management network: %s", config.ControllerScope)
	}
}

func TestLoadAllowsAnExplicitControllerScope(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
		"ANTNEST_RUNTIME_CONTROLLER_SCOPE":        "deployment-a",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.ControllerScope != "deployment-a" {
		t.Fatalf("controller scope = %q", config.ControllerScope)
	}
}

func TestLoadSkillPreparationRequiresRegistryPair(t *testing.T) {
	base := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "antnest-runtime-management"}
	for _, key := range []string{"ANTNEST_SKILL_REGISTRY_URL", "ANTNEST_SKILL_REGISTRY_API_TOKEN"} {
		values := map[string]string{}
		for k, v := range base {
			values[k] = v
		}
		values[key] = "configured"
		if _, err := Load(func(name string) string { return values[name] }); err == nil {
			t.Fatalf("accepted partial Skill Registry configuration: %s", key)
		}
	}
	base["ANTNEST_SKILL_REGISTRY_URL"] = "http://skill-registry:8080"
	base["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "test-token"
	configuration, err := Load(func(name string) string { return base[name] })
	if err != nil || configuration.SkillRegistryURL != "http://skill-registry:8080" || configuration.SkillRegistryToken != "test-token" {
		t.Fatalf("Skill Registry configuration: %+v %v", configuration, err)
	}
}

func TestLoadRejectsInvalidDeploymentBoundary(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]string
	}{
		{name: "database", values: map[string]string{
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "antnest-runtime-management",
		}},
		{name: "management network", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		}},
		{name: "unsupported platform", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			"ANTNEST_RUNTIME_PLATFORM":                "nomad",
		}},
		{name: "remote Docker host", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			"ANTNEST_DOCKER_HOST":                     "tcp://docker:2375",
		}},
		{name: "invalid timeout", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			"ANTNEST_RUNTIME_STATUS_TIMEOUT":          "zero",
		}},
		{name: "RPC shorter than mutation", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			"ANTNEST_RUNTIME_RPC_TIMEOUT":             "30s",
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Load(func(key string) string { return test.values[key] }); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestLoadPassesOnlyRuntimeSupportedOTELConfiguration(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
		"OTEL_SDK_DISABLED":                       "false",
		"OTEL_EXPORTER_OTLP_ENDPOINT":             "http://collector:4318",
		"OTEL_EXPORTER_OTLP_HEADERS":              "must-not-be-forwarded",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.RuntimeOTEL["OTEL_EXPORTER_OTLP_ENDPOINT"] != "http://collector:4318" ||
		config.RuntimeOTEL["OTEL_EXPORTER_OTLP_HEADERS"] != "" {
		t.Fatalf("unexpected Runtime telemetry environment: %+v", config.RuntimeOTEL)
	}
}

func TestLoadUsesRuntimeSpecificOTELOverrides(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":     "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":          "antnest-runtime-management",
		"OTEL_EXPORTER_OTLP_ENDPOINT":                 "http://collector:4318",
		"OTEL_METRICS_EXPORTER":                       "otlp",
		"ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT": "http://172.30.255.4:4318",
		"ANTNEST_RUNTIME_OTEL_METRICS_EXPORTER":       "none",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.RuntimeOTEL["OTEL_EXPORTER_OTLP_ENDPOINT"] != "http://172.30.255.4:4318" ||
		config.RuntimeOTEL["OTEL_METRICS_EXPORTER"] != "none" {
		t.Fatalf("Runtime-specific telemetry did not override service telemetry: %+v", config.RuntimeOTEL)
	}
}

func TestRuntimeRPCContentSwitchUsesSharedEnvironment(t *testing.T) {
	for _, test := range []struct{ mode, want string }{
		{"", "false"}, {"true", "true"}, {"false", "false"},
	} {
		values := map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":    "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":         "management",
			"ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT":      test.mode,
			"ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_HEADERS": "CREDENTIAL_CANARY",
		}
		configuration, err := Load(func(key string) string { return values[key] })
		if err != nil {
			t.Fatal(err)
		}
		if configuration.RuntimeOTEL["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"] != test.want || configuration.RuntimeOTEL["OTEL_EXPORTER_OTLP_HEADERS"] != "" {
			t.Fatal("shared capture switch or credential allowlist changed")
		}
		values["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"] = "invalid"
		if _, err := Load(func(key string) string { return values[key] }); err == nil {
			t.Fatal("invalid switch accepted")
		}
	}
}
