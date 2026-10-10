package config

import "testing"

func publicEntryEnvironment() map[string]string {
	return map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "http://identity-service:8080",
		"ANTNEST_ADMIN_CONSOLE_URL":    "http://admin-console:8080",
		"ANTNEST_AGENT_UI_URL":         "http://agent-ui:8080",
		"ANTNEST_AGENT_CONTROLLER_URL": "http://agent-controller:8080",
		"ANTNEST_AGENT_ACP_URL":        "http://agent-acp-service:8080",
		"ANTNEST_EDGE_CSRF_KEY_FILE":   "/run/antnest/csrf.key",
		"ANTNEST_EDGE_PUBLIC_ORIGIN":   "https://antnest.example",
		"ANTNEST_EDGE_TRUSTED_PROXIES": "10.1.0.0/24",
	}
}

func TestLoadRejectsUnsafePublicEntry(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		values map[string]string
	}{
		{"wildcard without origin", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": ""}},
		{"insecure container cookies", map[string]string{"ANTNEST_EDGE_COOKIE_SECURE": "false"}},
		{"remote HTTP origin", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "http://antnest.example"}},
		{"origin path", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://antnest.example/"}},
		{"origin credentials", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://user@antnest.example"}},
		{"origin empty query", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://antnest.example?"}},
		{"origin fragment", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://antnest.example#fragment"}},
		{"multiple origins", map[string]string{"ANTNEST_EDGE_PUBLIC_ORIGIN": "https://one.example https://two.example"}},
		{"HTTPS without TLS or proxy", map[string]string{"ANTNEST_EDGE_TRUSTED_PROXIES": ""}},
		{"invalid proxy", map[string]string{"ANTNEST_EDGE_TRUSTED_PROXIES": "proxy.example"}},
		{"empty proxy member", map[string]string{"ANTNEST_EDGE_TRUSTED_PROXIES": "10.1.0.0/24,"}},
		{"certificate without key", map[string]string{"ANTNEST_EDGE_TLS_CERT_FILE": "/cert.pem"}},
		{"key without certificate", map[string]string{"ANTNEST_EDGE_TLS_KEY_FILE": "/key.pem"}},
		{"native TLS with HTTP origin", map[string]string{"ANTNEST_EDGE_TLS_CERT_FILE": "/cert.pem", "ANTNEST_EDGE_TLS_KEY_FILE": "/key.pem", "ANTNEST_EDGE_PUBLIC_ORIGIN": "http://127.0.0.1:8090"}},
		{"hostname listener is not loopback", map[string]string{"ANTNEST_EDGE_LISTEN": "localhost:8080", "ANTNEST_EDGE_PUBLIC_ORIGIN": "", "ANTNEST_EDGE_COOKIE_SECURE": "false"}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			values := publicEntryEnvironment()
			for key, value := range fixture.values {
				values[key] = value
			}
			if _, err := Load(func(key string) string { return values[key] }); err == nil {
				t.Fatal("unsafe public entry accepted")
			}
		})
	}
}

func TestLoadAcceptsSupportedPublicEntries(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		values map[string]string
	}{
		{"trusted HTTPS proxy", nil},
		{"native TLS", map[string]string{"ANTNEST_EDGE_TLS_CERT_FILE": "/cert.pem", "ANTNEST_EDGE_TLS_KEY_FILE": "/key.pem", "ANTNEST_EDGE_TRUSTED_PROXIES": ""}},
		{"loopback development", map[string]string{"ANTNEST_EDGE_LISTEN": "127.0.0.1:8080", "ANTNEST_EDGE_PUBLIC_ORIGIN": "", "ANTNEST_EDGE_COOKIE_SECURE": "false", "ANTNEST_EDGE_TRUSTED_PROXIES": ""}},
		{"IPv6 loopback development", map[string]string{"ANTNEST_EDGE_LISTEN": "[::1]:8080", "ANTNEST_EDGE_PUBLIC_ORIGIN": "", "ANTNEST_EDGE_COOKIE_SECURE": "false", "ANTNEST_EDGE_TRUSTED_PROXIES": ""}},
		{"container published on loopback", map[string]string{"ANTNEST_EDGE_LISTEN": "10.241.0.130:8080", "ANTNEST_EDGE_PUBLIC_ORIGIN": "http://127.0.0.1:8090", "ANTNEST_EDGE_TRUSTED_PROXIES": ""}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			values := publicEntryEnvironment()
			for key, value := range fixture.values {
				values[key] = value
			}
			if _, err := Load(func(key string) string { return values[key] }); err != nil {
				t.Fatalf("supported public entry rejected: %v", err)
			}
		})
	}
}
