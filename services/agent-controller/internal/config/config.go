package config

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

type Config struct {
	Execution                      ExecutionConfiguration
	ListenAddress                  string
	TemporalAddress                string
	DatabaseURL                    string
	EncryptionKey                  []byte
	RuntimeEgressURL               string
	RuntimeControllerURL           string
	IdentityServiceURL             string
	SkillRegistryURL               string
	SkillRegistryAPIToken          string
	DependencyTimeout              time.Duration
	DrainTimeout                   time.Duration
	ObservationPollInterval        time.Duration
	IdentityRevocationPollInterval time.Duration
	ShutdownTimeout                time.Duration
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	execution, err := loadExecutionConfiguration(lookup)
	if err != nil {
		return Config{}, err
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
	drainTimeout, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT"),
		"ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT",
		5*time.Minute,
	)
	if err != nil {
		return Config{}, err
	}
	observationPollInterval, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL"),
		"ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL",
		2*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	identityRevocationPollInterval, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL"),
		"ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL", 2*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		Execution:                      execution,
		TemporalAddress:                strings.TrimSpace(lookup("ANTNEST_TEMPORAL_ADDRESS")),
		ListenAddress:                  strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_LISTEN")),
		DatabaseURL:                    strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_DATABASE_URL")),
		RuntimeEgressURL:               strings.TrimSpace(lookup("ANTNEST_RUNTIME_EGRESS_URL")),
		RuntimeControllerURL:           strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_URL")),
		IdentityServiceURL:             strings.TrimSpace(lookup("ANTNEST_IDENTITY_SERVICE_URL")),
		SkillRegistryURL:               strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_URL")),
		SkillRegistryAPIToken:          strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_API_TOKEN")),
		DependencyTimeout:              dependencyTimeout,
		DrainTimeout:                   drainTimeout,
		ObservationPollInterval:        observationPollInterval,
		IdentityRevocationPollInterval: identityRevocationPollInterval,
		ShutdownTimeout:                shutdownTimeout,
	}
	if config.ListenAddress == "" {
		config.ListenAddress = ":8080"
	}
	if config.TemporalAddress == "" {
		config.TemporalAddress = "127.0.0.1:7233"
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
	if config.IdentityServiceURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_IDENTITY_SERVICE_URL is required")
	}
	if (config.SkillRegistryURL == "") != (config.SkillRegistryAPIToken == "") {
		return Config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_URL and ANTNEST_SKILL_REGISTRY_API_TOKEN must be configured together")
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
