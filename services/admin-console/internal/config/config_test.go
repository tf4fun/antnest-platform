package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesDefaultsAndAllowsEmptyRuntimePrefill(t *testing.T) {
	values := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL":  "http://identity-service:8080",
		"ANTNEST_AGENT_CONTROLLER_URL":  "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_SERVICE_URL": "http://agent-acp-service:8080",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if config.ListenAddress != ":8080" || config.DependencyTimeout != 15*time.Second ||
		config.DefaultRuntimeImageRef != "" {
		t.Fatalf("config=%+v", config)
	}
}

func TestLoadPreservesRuntimeImagePrefill(t *testing.T) {
	for _, image := range []string{
		"antnest/antnest-runtime:local",
		"antnest/runtime:latest",
		"registry.example:5000/team/runtime:release-1",
		"sha256:" + strings.Repeat("a", 64),
		"registry.example/runtime@sha256:" + strings.Repeat("b", 64),
	} {
		t.Run(image, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
				"ANTNEST_AGENT_CONTROLLER_URL":            "http://agent-controller:8080",
				"ANTNEST_AGENT_ACP_SERVICE_URL":           "http://agent-acp-service:8080",
				"ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF": "  " + image + "  ",
			}
			config, err := Load(func(key string) string { return values[key] })
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if config.DefaultRuntimeImageRef != image {
				t.Fatalf("runtime prefill=%q, want %q", config.DefaultRuntimeImageRef, image)
			}
		})
	}
}

func TestLoadRejectsInvalidDependencies(t *testing.T) {
	base := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL":  "http://identity-service:8080",
		"ANTNEST_AGENT_CONTROLLER_URL":  "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_SERVICE_URL": "http://agent-acp-service:8080",
	}
	for _, test := range []struct {
		key, value string
		remove     bool
	}{
		{key: "ANTNEST_IDENTITY_SERVICE_URL", remove: true},
		{key: "ANTNEST_AGENT_CONTROLLER_URL", value: "agent-controller"},
		{key: "ANTNEST_AGENT_ACP_SERVICE_URL", remove: true},
		{key: "ANTNEST_AGENT_ACP_SERVICE_URL", value: "file:///tmp/acp"},
	} {
		values := make(map[string]string, len(base)+1)
		for key, value := range base {
			values[key] = value
		}
		if test.remove {
			delete(values, test.key)
		} else {
			values[test.key] = test.value
		}
		if _, err := Load(func(key string) string { return values[key] }); err == nil {
			t.Fatalf("Load accepted %s=%q", test.key, test.value)
		}
	}
}

func TestLoadRequiresPairedSkillRegistryAddressAndServiceToken(t *testing.T) {
	base := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL":  "http://identity-service:8080",
		"ANTNEST_AGENT_CONTROLLER_URL":  "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_SERVICE_URL": "http://agent-acp-service:8080",
	}
	lookup := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	for _, values := range []map[string]string{
		{"ANTNEST_SKILL_REGISTRY_URL": "http://skill-registry:8080"},
		{"ANTNEST_SKILL_REGISTRY_API_TOKEN": "local-skill-registry-token-000000000000"},
		{"ANTNEST_SKILL_REGISTRY_URL": "file:///tmp/registry", "ANTNEST_SKILL_REGISTRY_API_TOKEN": "local-skill-registry-token-000000000000"},
		{"ANTNEST_SKILL_REGISTRY_URL": "http://skill-registry:8080", "ANTNEST_SKILL_REGISTRY_API_TOKEN": "short"},
	} {
		input := make(map[string]string)
		for key, value := range base {
			input[key] = value
		}
		for key, value := range values {
			input[key] = value
		}
		if _, err := Load(lookup(input)); err == nil {
			t.Fatalf("accepted invalid Registry config: %v", values)
		}
	}
	base["ANTNEST_SKILL_REGISTRY_URL"] = "http://skill-registry:8080"
	base["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "local-skill-registry-token-000000000000"
	config, err := Load(lookup(base))
	if err != nil || config.SkillRegistryURL != base["ANTNEST_SKILL_REGISTRY_URL"] {
		t.Fatalf("config=%+v err=%v", config, err)
	}
}
