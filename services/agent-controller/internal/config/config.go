package config

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

type Config struct {
	ListenAddress        string
	DatabaseURL          string
	EncryptionKey        []byte
	RuntimeEgressURL     string
	RuntimeControllerURL string
	DependencyTimeout    time.Duration
	ShutdownTimeout      time.Duration
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	shutdownTimeout, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT"),
		"ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT",
		15*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	dependencyTimeout, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT"),
		"ANTNEST_AGENT_CONTROLLER_DEPENDENCY_TIMEOUT",
		150*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress:        strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_LISTEN")),
		DatabaseURL:          strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_DATABASE_URL")),
		RuntimeEgressURL:     strings.TrimSpace(lookup("ANTNEST_RUNTIME_EGRESS_URL")),
		RuntimeControllerURL: strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_URL")),
		DependencyTimeout:    dependencyTimeout,
		ShutdownTimeout:      shutdownTimeout,
	}
	if config.ListenAddress == "" {
		config.ListenAddress = ":8080"
	}
	if config.DatabaseURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_DATABASE_URL is required")
	}
	if config.RuntimeEgressURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_EGRESS_URL is required")
	}
	if config.RuntimeControllerURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_CONTROLLER_URL is required")
	}
	key, err := decodeEncryptionKey(strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY")))
	if err != nil {
		return Config{}, err
	}
	config.EncryptionKey = key
	return config, nil
}

func decodeEncryptionKey(raw string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != raw {
		return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

func positiveDuration(raw string, key string, fallback time.Duration) (time.Duration, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return value, nil
}
