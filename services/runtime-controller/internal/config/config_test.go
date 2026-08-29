package config

import "testing"

func TestLoadUsesDockerFirstDefaults(t *testing.T) {
	values := map[string]string{
		"ANTNEST_RUNTIME_DATABASE_URL":        "postgres://runtime:runtime@postgres/runtime",
		"ANTNEST_RUNTIME_ADVERTISED_ENDPOINT": "172.30.255.2:8091",
		"ANTNEST_RUNTIME_EGRESS_URL":          "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_EGRESS_ENDPOINT":     "172.30.255.3:8092",
		"ANTNEST_RUNTIME_PROVIDER_URL":        "http://runtime-provider-docker:8082",
		"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":  "antnest-runtime-management",
		"ANTNEST_RUNTIME_TOKEN_SECRET":        "01234567890123456789012345678901",
	}
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.ListenAddress != ":8080" || config.RuntimeListenAddress != ":8091" {
		t.Fatalf("unexpected listeners: %+v", config)
	}
	if config.TunnelCIDR != "100.64.0.0/10" || config.DNSIPv4 != "100.64.0.1" {
		t.Fatalf("unexpected Runtime network defaults: %+v", config)
	}
	if config.AdvertisedEndpoint != "172.30.255.2:8091" ||
		config.ManagementNetwork != "antnest-runtime-management" {
		t.Fatalf("unexpected advertised endpoint: %q", config.AdvertisedEndpoint)
	}
}

func TestLoadRejectsMissingRuntimeBoundaryConfiguration(t *testing.T) {
	tests := []struct {
		name   string
		values map[string]string
	}{
		{name: "database", values: map[string]string{
			"ANTNEST_RUNTIME_ADVERTISED_ENDPOINT": "172.30.255.2:8091",
			"ANTNEST_RUNTIME_EGRESS_URL":          "http://runtime-egress:8081",
			"ANTNEST_RUNTIME_EGRESS_ENDPOINT":     "172.30.255.3:8092",
			"ANTNEST_RUNTIME_PROVIDER_URL":        "http://runtime-provider-docker:8082",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":  "antnest-runtime-management",
			"ANTNEST_RUNTIME_TOKEN_SECRET":        "01234567890123456789012345678901",
		}},
		{name: "advertised endpoint", values: map[string]string{
			"ANTNEST_RUNTIME_DATABASE_URL":       "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_EGRESS_URL":         "http://runtime-egress:8081",
			"ANTNEST_RUNTIME_EGRESS_ENDPOINT":    "172.30.255.3:8092",
			"ANTNEST_RUNTIME_PROVIDER_URL":       "http://runtime-provider-docker:8082",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "antnest-runtime-management",
			"ANTNEST_RUNTIME_TOKEN_SECRET":       "01234567890123456789012345678901",
		}},
		{name: "management network", values: map[string]string{
			"ANTNEST_RUNTIME_DATABASE_URL":        "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_ADVERTISED_ENDPOINT": "172.30.255.2:8091",
			"ANTNEST_RUNTIME_EGRESS_URL":          "http://runtime-egress:8081",
			"ANTNEST_RUNTIME_EGRESS_ENDPOINT":     "172.30.255.3:8092",
			"ANTNEST_RUNTIME_PROVIDER_URL":        "http://runtime-provider-docker:8082",
			"ANTNEST_RUNTIME_TOKEN_SECRET":        "01234567890123456789012345678901",
		}},
		{name: "short token secret", values: map[string]string{
			"ANTNEST_RUNTIME_DATABASE_URL":        "postgres://runtime:runtime@postgres/runtime",
			"ANTNEST_RUNTIME_ADVERTISED_ENDPOINT": "172.30.255.2:8091",
			"ANTNEST_RUNTIME_MANAGEMENT_NETWORK":  "antnest-runtime-management",
			"ANTNEST_RUNTIME_EGRESS_URL":          "http://runtime-egress:8081",
			"ANTNEST_RUNTIME_EGRESS_ENDPOINT":     "172.30.255.3:8092",
			"ANTNEST_RUNTIME_PROVIDER_URL":        "http://runtime-provider-docker:8082",
			"ANTNEST_RUNTIME_TOKEN_SECRET":        "short",
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Load(func(key string) string { return test.values[key] })
			if err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}
