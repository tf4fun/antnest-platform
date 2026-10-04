package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadUsesThinDockerAdapterDefaults(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
	}
	config, err := Load(testEnvironment(t, values))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.ListenAddress != "127.0.0.1:8080" || config.Platform != "docker" ||
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
	config, err := Load(testEnvironment(t, values))
	if err != nil {
		t.Fatal(err)
	}
	if config.ControllerScope != "deployment-a" {
		t.Fatalf("controller scope = %q", config.ControllerScope)
	}
}

func TestLoadRejectsInvalidMonitorRetryLimit(t *testing.T) {
	for _, raw := range []string{"invalid", "0s", "-1s", "500ms"} {
		t.Run(raw, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":            "postgres://runtime:runtime@postgres/runtime",
				"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":                 "antnest-runtime-management",
				"ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY": raw,
			}
			_, err := Load(testEnvironment(t, values))
			if err == nil || !strings.Contains(err.Error(), "ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY") {
				t.Fatalf("invalid monitor retry limit %q was not rejected: %v", raw, err)
			}
		})
	}
}

func TestLoadMonitorRetryLimit(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want time.Duration
	}{{"", 30 * time.Second}, {"1s", time.Second}, {"45s", 45 * time.Second}} {
		t.Run(test.raw, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":            "postgres://runtime:runtime@postgres/runtime",
				"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":                 "antnest-runtime-management",
				"ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY": test.raw,
			}
			loaded, err := Load(testEnvironment(t, values))
			if err != nil || loaded.MonitorMaxRetryDelay != test.want {
				t.Fatalf("monitor retry limit = %s, want %s: %v", loaded.MonitorMaxRetryDelay, test.want, err)
			}
		})
	}
}

func TestLoadMaintenanceVerifierBootstrap(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
	}
	loaded, err := Load(testEnvironment(t, values))
	if err != nil || len(loaded.MaintenanceVerifiers.Keys) != 0 {
		t.Fatalf("maintenance must default closed: %+v %v", loaded.MaintenanceVerifiers, err)
	}
	values["ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS"] = `{"keys":[{"kid":"next","algorithm":"Ed25519","public_key_base64url":"AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},{"kid":"current","algorithm":"Ed25519","public_key_base64url":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`
	loaded, err = Load(testEnvironment(t, values))
	if err != nil || len(loaded.MaintenanceVerifiers.Keys) != 2 || loaded.MaintenanceVerifiers.Keys[0].KID != "current" {
		t.Fatalf("maintenance bootstrap not normalized: %+v %v", loaded.MaintenanceVerifiers, err)
	}
	values["ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS"] = `{"keys":[{"kid":"bad key","algorithm":"Ed25519","public_key_base64url":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`
	if _, err := Load(testEnvironment(t, values)); err == nil {
		t.Fatal("invalid maintenance key configuration accepted")
	}
	for _, malformed := range []string{`null`, `{}`, `{"keys":null}`, `[]`} {
		values["ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS"] = malformed
		if _, err := Load(testEnvironment(t, values)); err == nil {
			t.Fatalf("non-object maintenance verifier set accepted: %s", malformed)
		}
	}
}

func TestLoadMaintenanceVerifierRejectionNamesEnvironmentVariable(t *testing.T) {
	for _, kid := range []string{"release.2026", "bad key"} {
		t.Run(kid, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL":     "postgres://runtime:runtime@postgres/runtime",
				"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":          "antnest-runtime-management",
				"ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS": `{"keys":[{"kid":"` + kid + `","algorithm":"Ed25519","public_key_base64url":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}`,
			}
			_, err := Load(testEnvironment(t, values))
			if err == nil || !strings.Contains(err.Error(), "ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS") {
				t.Fatalf("rejection does not identify the configured variable: %v", err)
			}
		})
	}
}

func TestLoadSkillPreparationUsesAuthenticatedRegistry(t *testing.T) {
	base := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "antnest-runtime-management", "ANTNEST_SKILL_REGISTRY_URL": "http://skill-registry:8080"}
	configuration, err := Load(testEnvironment(t, base))
	if err != nil || configuration.SkillRegistryURL != "http://skill-registry:8080" {
		t.Fatalf("authenticated Registry configuration: %v", err)
	}
	base["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "test-token"
	if _, err := Load(testEnvironment(t, base)); err == nil {
		t.Fatal("retired Registry token was accepted")
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
			if _, err := Load(testEnvironment(t, test.values)); err == nil {
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
	config, err := Load(testEnvironment(t, values))
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
	config, err := Load(testEnvironment(t, values))
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
		configuration, err := Load(testEnvironment(t, values))
		if err != nil {
			t.Fatal(err)
		}
		if configuration.RuntimeOTEL["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"] != test.want || configuration.RuntimeOTEL["OTEL_EXPORTER_OTLP_HEADERS"] != "" {
			t.Fatal("shared capture switch or credential allowlist changed")
		}
		values["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"] = "invalid"
		if _, err := Load(testEnvironment(t, values)); err == nil {
			t.Fatal("invalid switch accepted")
		}
	}
}
