package config

import (
	"fmt"
	"strings"
)

type Config struct {
	ListenAddress        string
	RuntimeListenAddress string
	DatabaseURL          string
	AdvertisedEndpoint   string
	EgressURL            string
	EgressEndpoint       string
	ProviderURL          string
	ManagementNetwork    string
	TokenSecret          []byte
	TunnelCIDR           string
	DNSIPv4              string
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	config := Config{
		ListenAddress:        valueOr(lookup, "ANTNEST_RUNTIME_LISTEN", ":8080"),
		RuntimeListenAddress: valueOr(lookup, "ANTNEST_RUNTIME_CONTROL_LISTEN", ":8091"),
		DatabaseURL:          strings.TrimSpace(lookup("ANTNEST_RUNTIME_DATABASE_URL")),
		AdvertisedEndpoint:   strings.TrimSpace(lookup("ANTNEST_RUNTIME_ADVERTISED_ENDPOINT")),
		EgressURL:            strings.TrimRight(strings.TrimSpace(lookup("ANTNEST_RUNTIME_EGRESS_URL")), "/"),
		EgressEndpoint:       strings.TrimSpace(lookup("ANTNEST_RUNTIME_EGRESS_ENDPOINT")),
		ProviderURL:          strings.TrimRight(strings.TrimSpace(lookup("ANTNEST_RUNTIME_PROVIDER_URL")), "/"),
		ManagementNetwork:    strings.TrimSpace(lookup("ANTNEST_RUNTIME_MANAGEMENT_NETWORK")),
		TokenSecret:          []byte(strings.TrimSpace(lookup("ANTNEST_RUNTIME_TOKEN_SECRET"))),
		TunnelCIDR:           valueOr(lookup, "ANTNEST_RUNTIME_TUNNEL_CIDR", "100.64.0.0/10"),
		DNSIPv4:              valueOr(lookup, "ANTNEST_RUNTIME_DNS_IPV4", "100.64.0.1"),
	}
	if config.DatabaseURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_DATABASE_URL is required")
	}
	if config.AdvertisedEndpoint == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_ADVERTISED_ENDPOINT is required")
	}
	if config.EgressURL == "" || config.EgressEndpoint == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_EGRESS_URL and ANTNEST_RUNTIME_EGRESS_ENDPOINT are required")
	}
	if config.ProviderURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_PROVIDER_URL is required")
	}
	if config.ManagementNetwork == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_MANAGEMENT_NETWORK is required")
	}
	if len(config.TokenSecret) < 32 {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_TOKEN_SECRET must contain at least 32 bytes")
	}
	return config, nil
}

func valueOr(lookup func(string) string, key, fallback string) string {
	value := strings.TrimSpace(lookup(key))
	if value == "" {
		return fallback
	}
	return value
}
