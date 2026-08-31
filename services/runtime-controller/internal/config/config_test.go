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
		config.RuntimeReadyTimeout != time.Minute ||
		config.ObservationRetention != 7*24*time.Hour || config.RPCRequestTimeout != 3*time.Minute ||
		config.ReconciliationTimeout != 2*time.Minute {
		t.Fatalf("unexpected bounded-operation defaults: %+v", config)
	}
	if config.SystemSkillsVolume != "antnest-system-skills" {
		t.Fatalf("unexpected system Skills volume: %s", config.SystemSkillsVolume)
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
		{name: "mutation shorter than readiness", values: map[string]string{
			"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":      "antnest-runtime-management",
			"ANTNEST_RUNTIME_MUTATION_TIMEOUT":        "30s",
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
