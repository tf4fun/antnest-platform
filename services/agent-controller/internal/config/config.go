package config

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type Config struct {
	Authentication                 *serviceauth.Clients
	Execution                      ExecutionConfiguration
	ListenAddress                  string
	TemporalAddress                string
	DatabaseURL                    string
	EncryptionKey                  []byte
	RuntimeEgressURL               string
	RuntimeControllerURL           string
	IdentityServiceURL             string
	SkillRegistryURL               string
	ProviderAllowPrivateEndpoints  bool
	DependencyTimeout              time.Duration
	DrainTimeout                   time.Duration
	ObservationPollInterval        time.Duration
	IdentityRevocationPollInterval time.Duration
	ShutdownTimeout                time.Duration
}

func Load(environment serviceauth.LookupEnv) (Config, error) {
	if environment == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	lookup := func(key string) string { value, _ := environment(key); return value }
	privateValue, privatePresent := environment("ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS")
	if privatePresent && privateValue != "true" && privateValue != "false" {
		return Config{}, fmt.Errorf("ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS must be exactly true or false")
	}
	if lookup("ANTNEST_SKILL_REGISTRY_API_TOKEN") != "" {
		return Config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_API_TOKEN is no longer supported; configure per-receiver service credentials")
	}
	if lookup("ANTNEST_AGENT_ACP_SERVICE_URL") != "" {
		return Config{}, fmt.Errorf("ANTNEST_AGENT_ACP_SERVICE_URL is not a Controller control endpoint; use ANTNEST_AGENT_ACP_CONTROL_URL")
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
		ProviderAllowPrivateEndpoints:  privateValue == "true",
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
	key, err := decodeEncryptionKey(strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY")))
	if err != nil {
		return Config{}, err
	}
	config.EncryptionKey = key
	endpoints := map[string]string{"identity-service": config.IdentityServiceURL, "agent-acp-service": config.Execution.URL,
		"runtime-controller": config.RuntimeControllerURL, "runtime-egress": config.RuntimeEgressURL}
	if config.SkillRegistryURL != "" {
		endpoints["skill-registry"] = config.SkillRegistryURL
	}
	config.Authentication, err = serviceauth.LoadOutbound("agent-controller", serviceauth.CallerContextHeaders, environment, endpoints)
	if err != nil {
		return Config{}, err
	}
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
