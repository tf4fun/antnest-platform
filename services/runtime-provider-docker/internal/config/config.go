package config

import (
	"fmt"
	"strings"
)

type Config struct {
	ListenAddress string
	DockerSocket  string
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	return Config{
		ListenAddress: valueOr(lookup, "ANTNEST_RUNTIME_PROVIDER_LISTEN", ":8082"),
		DockerSocket:  valueOr(lookup, "ANTNEST_RUNTIME_DOCKER_SOCKET", "/var/run/docker.sock"),
	}, nil
}

func valueOr(lookup func(string) string, key, fallback string) string {
	if value := strings.TrimSpace(lookup(key)); value != "" {
		return value
	}
	return fallback
}
