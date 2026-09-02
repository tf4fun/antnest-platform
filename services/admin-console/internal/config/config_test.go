package config

import (
	"testing"
	"time"
)

func TestLoadAppliesDefaultsAndAllowsEmptyRuntimePrefill(t *testing.T) {
	values := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
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

func TestLoadRejectsMissingDependenciesAndMutableRuntimeTag(t *testing.T) {
	base := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
	}
	for _, test := range []struct {
		key, value string
		remove     bool
	}{
		{key: "ANTNEST_IDENTITY_SERVICE_URL", remove: true},
		{key: "ANTNEST_AGENT_CONTROLLER_URL", value: "agent-controller"},
		{key: "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF", value: "antnest/runtime:latest"},
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
