package config

import (
	"fmt"
	"strings"
)

type Config struct {
	ListenAddress        string
	RuntimeListenAddress string
	TokenSecret          []byte
	TunnelCIDR           string
	DNSIPv4              string
	DNSUpstream          string
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	configuration := Config{
		ListenAddress:        valueOr(lookup, "ANTNEST_EGRESS_LISTEN", ":8081"),
		RuntimeListenAddress: valueOr(lookup, "ANTNEST_EGRESS_RUNTIME_LISTEN", ":8092"),
		TokenSecret:          []byte(strings.TrimSpace(lookup("ANTNEST_RUNTIME_TOKEN_SECRET"))),
		TunnelCIDR:           valueOr(lookup, "ANTNEST_RUNTIME_TUNNEL_CIDR", "100.64.0.0/10"),
		DNSIPv4:              valueOr(lookup, "ANTNEST_RUNTIME_DNS_IPV4", "100.64.0.1"),
		DNSUpstream:          valueOr(lookup, "ANTNEST_RUNTIME_DNS_UPSTREAM", "1.1.1.1:53"),
	}
	if len(configuration.TokenSecret) < 32 {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_TOKEN_SECRET must contain at least 32 bytes")
	}
	return configuration, nil
}

func valueOr(lookup func(string) string, key, fallback string) string {
	if value := strings.TrimSpace(lookup(key)); value != "" {
		return value
	}
	return fallback
}
