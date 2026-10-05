package config

import (
	"encoding/base64"
	"testing"
)

func TestProviderPrivateFlagUsesExactPresenceSemantics(t *testing.T) {
	for _, scenario := range []struct {
		name, value             string
		present, valid, enabled bool
	}{
		{"absent", "", false, true, false}, {"false", "false", true, true, false}, {"true", "true", true, true, true},
		{"empty", "", true, false, false}, {"spaces", " ", true, false, false}, {"padded", "true ", true, false, false},
		{"capitalized", "True", true, false, false}, {"number", "1", true, false, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			values := authenticationEnvironment(t)
			for key, value := range map[string]string{
				"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://acp:8081",
				"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
				"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
				"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081", "ANTNEST_RUNTIME_CONTROLLER_URL": "http://runtime-controller:8080",
				"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
			} {
				values[key] = value
			}
			if scenario.present {
				values["ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS"] = scenario.value
			}
			loaded, err := Load(func(key string) (string, bool) { value, present := values[key]; return value, present })
			if loaded.Authentication != nil {
				loaded.Authentication.CloseIdleConnections()
			}
			if (err == nil) != scenario.valid || err == nil && loaded.ProviderAllowPrivateEndpoints != scenario.enabled {
				t.Fatalf("private endpoint flag accepted incorrectly: %v", err)
			}
		})
	}
}
