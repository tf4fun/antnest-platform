package config

import (
	"testing"
	"time"
)

func TestLoadDoesNotRequireRetiredWorkspaceDependencies(t *testing.T) {
	for _, oldURL := range []string{"", "invalid-retired-service-url"} {
		t.Run(oldURL, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
				"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
				"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
				"ANTNEST_EDGE_CSRF_KEY_FILE":   "/run/antnest/csrf.key",
				"ANTNEST_EDGE_PUBLIC_ORIGIN":   "https://antnest.example",
				"ANTNEST_EDGE_TRUSTED_PROXIES": "10.1.0.0/24",
				"ANTNEST_AGENT_CONTROLLER_URL": oldURL,
				"ANTNEST_AGENT_ACP_URL":        oldURL,
			}
			if _, err := Load(func(key string) string { return values[key] }); err != nil {
				t.Fatalf("retired downstream configuration still required: %v", err)
			}
		})
	}
}

func TestLoadAppliesSecureDefaults(t *testing.T) {
	values := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
		"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_URL":        "http://agent-acp-service:8080",
		"ANTNEST_EDGE_CSRF_KEY_FILE":   "/run/antnest/csrf.key",
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
		config.LoginAccountMax != 10 || config.LoginMaxKeys != 65536 ||
		config.OIDCStartSourceMax != 30 || config.ShutdownTimeout != 15*time.Second {
		t.Fatalf("defaults=%+v", config)
	}
}

func TestLoadLoginAdmissionLimits(t *testing.T) {
	for _, fixture := range []struct {
		name, keys, oidc   string
		wantKeys, wantOIDC int
	}{
		{"defaults", "", "", 65536, 30},
		{"whitespace defaults", " \t ", " \t ", 65536, 30},
		{"positive overrides", " 4 ", " 2 ", 4, 2},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			values := map[string]string{
				"ANTNEST_IDENTITY_SERVICE_URL":       "http://identity-service:8080",
				"ANTNEST_ADMIN_CONSOLE_URL":          "http://admin-console:8080",
				"ANTNEST_AGENT_UI_URL":               "http://agent-ui:8080",
				"ANTNEST_AGENT_CONTROLLER_URL":       "http://agent-controller:8080",
				"ANTNEST_AGENT_ACP_URL":              "http://agent-acp-service:8080",
				"ANTNEST_EDGE_CSRF_KEY_FILE":         "/run/antnest/csrf.key",
				"ANTNEST_EDGE_PUBLIC_ORIGIN":         "https://antnest.example",
				"ANTNEST_EDGE_TRUSTED_PROXIES":       "10.1.0.0/24",
				"ANTNEST_EDGE_LOGIN_MAX_KEYS":        fixture.keys,
				"ANTNEST_EDGE_OIDC_START_SOURCE_MAX": fixture.oidc,
			}
			got, err := Load(func(key string) string { return values[key] })
			if err != nil || got.LoginMaxKeys != fixture.wantKeys || got.OIDCStartSourceMax != fixture.wantOIDC {
				t.Fatalf("admission config=%+v err=%v", got, err)
			}
		})
	}
}

func TestLoadRejectsMissingOrInvalidDependencies(t *testing.T) {
	base := map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
		"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_URL":        "http://agent-acp-service:8080",
		"ANTNEST_EDGE_CSRF_KEY_FILE":   "/run/antnest/csrf.key",
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
		{name: "invalid secure flag", key: "ANTNEST_EDGE_COOKIE_SECURE", value: "perhaps"},
		{name: "invalid originless flag", key: "ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS", value: "perhaps"},
		{name: "missing CSRF key file", key: "ANTNEST_EDGE_CSRF_KEY_FILE", remove: true},
		{name: "empty CSRF key file", key: "ANTNEST_EDGE_CSRF_KEY_FILE", value: " \t "},
		{name: "invalid timeout", key: "ANTNEST_EDGE_REQUEST_TIMEOUT", value: "0s"},
		{name: "invalid stream lease", key: "ANTNEST_EDGE_STREAM_LEASE", value: "0s"},
		{name: "invalid login limit", key: "ANTNEST_EDGE_LOGIN_ACCOUNT_MAX", value: "zero"},
		{name: "zero login capacity", key: "ANTNEST_EDGE_LOGIN_MAX_KEYS", value: "0"},
		{name: "negative login capacity", key: "ANTNEST_EDGE_LOGIN_MAX_KEYS", value: "-1"},
		{name: "malformed login capacity", key: "ANTNEST_EDGE_LOGIN_MAX_KEYS", value: "many"},
		{name: "overflowing login capacity", key: "ANTNEST_EDGE_LOGIN_MAX_KEYS", value: "999999999999999999999999999"},
		{name: "zero OIDC source limit", key: "ANTNEST_EDGE_OIDC_START_SOURCE_MAX", value: "0"},
		{name: "negative OIDC source limit", key: "ANTNEST_EDGE_OIDC_START_SOURCE_MAX", value: "-1"},
		{name: "malformed OIDC source limit", key: "ANTNEST_EDGE_OIDC_START_SOURCE_MAX", value: "many"},
		{name: "overflowing OIDC source limit", key: "ANTNEST_EDGE_OIDC_START_SOURCE_MAX", value: "999999999999999999999999999"},
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
