package config

import (
	"testing"
	"time"
)

func TestLoadAppliesSecureDefaults(t *testing.T) {
	values := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
		"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_URL":        "http://agent-acp-service:8080",
		"ANTNEST_EDGE_PUBLIC_ORIGIN":   "https://antnest.example",
		"ANTNEST_EDGE_TRUSTED_PROXIES": "10.1.0.0/24",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if config.ListenAddress != ":8080" || !config.CookieSecure || config.AllowOriginlessMutations ||
		config.RequestTimeout != 10*time.Second || config.StreamLease != 5*time.Minute ||
		config.LoginWindow != 5*time.Minute || config.LoginSourceMax != 30 ||
		config.LoginAccountMax != 10 || config.ShutdownTimeout != 15*time.Second {
		t.Fatalf("defaults=%+v", config)
	}
}

func TestLoadRejectsMissingOrInvalidDependencies(t *testing.T) {
	base := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
		"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_URL":        "http://agent-acp-service:8080",
		"ANTNEST_EDGE_PUBLIC_ORIGIN":   "https://antnest.example",
		"ANTNEST_EDGE_TRUSTED_PROXIES": "10.1.0.0/24",
	}
	for _, test := range []struct {
		name   string
		key    string
		value  string
		remove bool
	}{
		{name: "missing identity", key: "ANTNEST_IDENTITY_SERVICE_URL", remove: true},
		{name: "invalid console", key: "ANTNEST_ADMIN_CONSOLE_URL", value: "console-only"},
		{name: "missing Agent UI", key: "ANTNEST_AGENT_UI_URL", remove: true},
		{name: "invalid Agent Controller", key: "ANTNEST_AGENT_CONTROLLER_URL", value: "controller-only"},
		{name: "invalid Agent ACP", key: "ANTNEST_AGENT_ACP_URL", value: "ws://agent-acp-service"},
		{name: "invalid secure flag", key: "ANTNEST_EDGE_COOKIE_SECURE", value: "perhaps"},
		{name: "invalid originless flag", key: "ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS", value: "perhaps"},
		{name: "invalid timeout", key: "ANTNEST_EDGE_REQUEST_TIMEOUT", value: "0s"},
		{name: "invalid stream lease", key: "ANTNEST_EDGE_STREAM_LEASE", value: "0s"},
		{name: "invalid login limit", key: "ANTNEST_EDGE_LOGIN_ACCOUNT_MAX", value: "zero"},
	} {
		t.Run(test.name, func(t *testing.T) {
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
				t.Fatal("Load succeeded")
			}
		})
	}
}
