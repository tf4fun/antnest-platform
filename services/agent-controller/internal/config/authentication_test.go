package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestProductionConfigurationRequiresExactWorkloadSettings(t *testing.T) {
	for _, scenario := range []struct {
		name, key, value string
		remove           bool
	}{
		{"missing mode", "ANTNEST_SERVICE_AUTH_MODE", "", true},
		{"spaced mode", "ANTNEST_SERVICE_AUTH_MODE", " token", false},
		{"empty insecure flag", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT", "", false},
		{"spaced insecure flag", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT", "true ", false},
		{"absent unsafe option requires TLS", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT", "", true},
		{"missing callers", "ANTNEST_SERVICE_AUTH_CALLERS_FILE", "", true},
		{"missing sender directory", "ANTNEST_SERVICE_AUTH_TOKEN_DIR", "", true},
		{"legacy workspace address", "ANTNEST_AGENT_ACP_SERVICE_URL", "http://acp:8080", false},
		{"legacy Registry token", "ANTNEST_SKILL_REGISTRY_API_TOKEN", " ", false},
		{"one origin for two services", "ANTNEST_IDENTITY_SERVICE_URL", "http://runtime-controller:8080", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			values := authenticationEnvironment(t)
			for key, value := range map[string]string{
				"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://acp:8081",
				"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
				"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
				"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081", "ANTNEST_RUNTIME_CONTROLLER_URL": "http://runtime-controller:8080",
				"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
			} {
				values[key] = value
			}
			if scenario.remove {
				delete(values, scenario.key)
			} else {
				values[scenario.key] = scenario.value
			}
			loaded, err := Load(func(key string) (string, bool) { value, present := values[key]; return value, present })
			if loaded.Authentication != nil {
				loaded.Authentication.CloseIdleConnections()
			}
			if err == nil {
				t.Fatal("invalid authentication configuration accepted")
			}
		})
	}
}

func TestEveryConfiguredDependencyCredentialIsCheckedAtStartup(t *testing.T) {
	for _, receiver := range []string{"identity-service", "runtime-controller", "runtime-egress", "agent-acp-service", "skill-registry"} {
		t.Run(receiver, func(t *testing.T) {
			values := authenticationEnvironment(t)
			if err := os.Remove(filepath.Join(values["ANTNEST_SERVICE_AUTH_TOKEN_DIR"], receiver)); err != nil {
				t.Fatal(err)
			}
			values["ANTNEST_AGENT_ACP_CONTROL_URL"] = "http://acp:8081"
			values["ANTNEST_AGENT_CONTROLLER_DATABASE_URL"] = "postgres://controller:secret@postgres/controller"
			values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 32))
			values["ANTNEST_RUNTIME_EGRESS_URL"] = "http://runtime-egress:8081"
			values["ANTNEST_RUNTIME_CONTROLLER_URL"] = "http://runtime-controller:8080"
			values["ANTNEST_IDENTITY_SERVICE_URL"] = "http://identity-service:8080"
			values["ANTNEST_SKILL_REGISTRY_URL"] = "http://skill-registry:8080"
			if _, err := Load(func(key string) (string, bool) { value, present := values[key]; return value, present }); err == nil {
				t.Fatal("missing dependency credential accepted")
			}
		})
	}
}
