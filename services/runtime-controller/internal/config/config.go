package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Config struct {
	ListenAddress         string
	DatabaseURL           string
	Platform              string
	DockerSocketPath      string
	ManagementNetwork     string
	SystemSkillsVolume    string
	RuntimeStatusTimeout  time.Duration
	MutationTimeout       time.Duration
	RuntimeReadyTimeout   time.Duration
	RuntimePollInterval   time.Duration
	RPCRequestTimeout     time.Duration
	ReconciliationTimeout time.Duration
	ObservationRetention  time.Duration
	SSEHeartbeat          time.Duration
	RuntimeOTEL           map[string]string
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	statusTimeout, err := duration(lookup, "ANTNEST_RUNTIME_STATUS_TIMEOUT", 5*time.Second)
	if err != nil {
		return Config{}, err
	}
	mutationTimeout, err := duration(lookup, "ANTNEST_RUNTIME_MUTATION_TIMEOUT", 2*time.Minute)
	if err != nil {
		return Config{}, err
	}
	readyTimeout, err := duration(lookup, "ANTNEST_RUNTIME_READY_TIMEOUT", time.Minute)
	if err != nil {
		return Config{}, err
	}
	pollInterval, err := duration(lookup, "ANTNEST_RUNTIME_POLL_INTERVAL", 500*time.Millisecond)
	if err != nil {
		return Config{}, err
	}
	rpcTimeout, err := duration(lookup, "ANTNEST_RUNTIME_RPC_TIMEOUT", 3*time.Minute)
	if err != nil {
		return Config{}, err
	}
	reconciliationTimeout, err := duration(
		lookup, "ANTNEST_RUNTIME_RECONCILIATION_TIMEOUT", 2*time.Minute,
	)
	if err != nil {
		return Config{}, err
	}
	retention, err := duration(lookup, "ANTNEST_OBSERVATION_RETENTION", 7*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	heartbeat, err := duration(lookup, "ANTNEST_RUNTIME_SSE_HEARTBEAT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress:         valueOr(lookup, "ANTNEST_RUNTIME_CONTROLLER_LISTEN", ":8080"),
		DatabaseURL:           strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL")),
		Platform:              strings.ToLower(valueOr(lookup, "ANTNEST_RUNTIME_PLATFORM", "docker")),
		ManagementNetwork:     strings.TrimSpace(lookup("ANTNEST_RUNTIME_MANAGEMENT_NETWORK")),
		SystemSkillsVolume:    valueOr(lookup, "ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME", "antnest-system-skills"),
		RuntimeStatusTimeout:  statusTimeout,
		MutationTimeout:       mutationTimeout,
		RuntimeReadyTimeout:   readyTimeout,
		RuntimePollInterval:   pollInterval,
		RPCRequestTimeout:     rpcTimeout,
		ReconciliationTimeout: reconciliationTimeout,
		ObservationRetention:  retention,
		SSEHeartbeat:          heartbeat,
		RuntimeOTEL:           runtimeTelemetryEnvironment(lookup),
	}
	if config.DatabaseURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL is required")
	}
	if config.Platform != "docker" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_PLATFORM currently supports only docker")
	}
	if config.ManagementNetwork == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_MANAGEMENT_NETWORK is required")
	}
	dockerHost := valueOr(lookup, "ANTNEST_DOCKER_HOST", "unix:///var/run/docker.sock")
	parsedHost, err := url.Parse(dockerHost)
	if err != nil || parsedHost.Scheme != "unix" || strings.TrimSpace(parsedHost.Path) == "" {
		return Config{}, fmt.Errorf("ANTNEST_DOCKER_HOST must be a unix:// socket URL")
	}
	config.DockerSocketPath = parsedHost.Path
	if config.RuntimePollInterval > config.RuntimeReadyTimeout {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_POLL_INTERVAL must not exceed ANTNEST_RUNTIME_READY_TIMEOUT")
	}
	if config.RuntimeReadyTimeout >= config.MutationTimeout {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_READY_TIMEOUT must be less than ANTNEST_RUNTIME_MUTATION_TIMEOUT")
	}
	if config.RPCRequestTimeout <= config.MutationTimeout {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_RPC_TIMEOUT must exceed ANTNEST_RUNTIME_MUTATION_TIMEOUT")
	}
	return config, nil
}

func runtimeTelemetryEnvironment(lookup func(string) string) map[string]string {
	result := make(map[string]string)
	for _, key := range []string{
		"OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER",
		"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	} {
		if value := strings.TrimSpace(lookup(key)); value != "" {
			result[key] = value
		}
	}
	return result
}

func duration(lookup func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(lookup(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return value, nil
}

func valueOr(lookup func(string) string, key, fallback string) string {
	value := strings.TrimSpace(lookup(key))
	if value == "" {
		return fallback
	}
	return value
}
