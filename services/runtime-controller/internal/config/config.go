package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

const MonitorRetryDelay = time.Second

type Config struct {
	ListenAddress         string
	DatabaseURL           string
	Platform              string
	DockerSocketPath      string
	ControllerScope       string
	ManagementNetwork     string
	SystemSkillsVolume    string
	SkillRegistryURL      string
	SkillRegistryToken    string
	SkillPreparerImage    string
	RuntimeStatusTimeout  time.Duration
	MutationTimeout       time.Duration
	RPCRequestTimeout     time.Duration
	ReconciliationTimeout time.Duration
	MonitorMaxRetryDelay  time.Duration
	ObservationRetention  time.Duration
	SSEHeartbeat          time.Duration
	RuntimeOTEL           map[string]string
	MaintenanceVerifiers  deployment.MaintenanceVerifiers
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
	monitorMaxRetryDelay, err := duration(
		lookup, "ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY", 30*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	if monitorMaxRetryDelay < MonitorRetryDelay {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_CONTROLLER_MONITOR_MAX_RETRY_DELAY must be at least %s", MonitorRetryDelay)
	}
	retention, err := duration(lookup, "ANTNEST_OBSERVATION_RETENTION", 7*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	heartbeat, err := duration(lookup, "ANTNEST_RUNTIME_SSE_HEARTBEAT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	maintenanceVerifiers, err := parseMaintenanceVerifiers(lookup("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS"))
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress:     valueOr(lookup, "ANTNEST_RUNTIME_CONTROLLER_LISTEN", ":8080"),
		DatabaseURL:       strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL")),
		Platform:          strings.ToLower(valueOr(lookup, "ANTNEST_RUNTIME_PLATFORM", "docker")),
		ManagementNetwork: strings.TrimSpace(lookup("ANTNEST_RUNTIME_MANAGEMENT_NETWORK")),
		ControllerScope: valueOr(
			lookup,
			"ANTNEST_RUNTIME_CONTROLLER_SCOPE",
			strings.TrimSpace(lookup("ANTNEST_RUNTIME_MANAGEMENT_NETWORK")),
		),
		SystemSkillsVolume:    valueOr(lookup, "ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME", "antnest-system-skills"),
		SkillRegistryURL:      strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_URL")),
		SkillRegistryToken:    strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_API_TOKEN")),
		SkillPreparerImage:    valueOr(lookup, "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE", "antnest/runtime-controller:local"),
		RuntimeStatusTimeout:  statusTimeout,
		MutationTimeout:       mutationTimeout,
		RPCRequestTimeout:     rpcTimeout,
		ReconciliationTimeout: reconciliationTimeout,
		MonitorMaxRetryDelay:  monitorMaxRetryDelay,
		ObservationRetention:  retention,
		SSEHeartbeat:          heartbeat,
		RuntimeOTEL:           runtimeTelemetryEnvironment(lookup),
		MaintenanceVerifiers:  maintenanceVerifiers,
	}
	if capture := config.RuntimeOTEL["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"]; capture != "true" && capture != "false" {
		return Config{}, fmt.Errorf("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT must be true or false")
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
	if config.ControllerScope == "" {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_CONTROLLER_SCOPE is required")
	}
	if (config.SkillRegistryURL == "") != (config.SkillRegistryToken == "") {
		return Config{}, fmt.Errorf("skill Registry URL and API token must be configured together")
	}
	dockerHost := valueOr(lookup, "ANTNEST_DOCKER_HOST", "unix:///var/run/docker.sock")
	parsedHost, err := url.Parse(dockerHost)
	if err != nil || parsedHost.Scheme != "unix" || strings.TrimSpace(parsedHost.Path) == "" {
		return Config{}, fmt.Errorf("ANTNEST_DOCKER_HOST must be a unix:// socket URL")
	}
	config.DockerSocketPath = parsedHost.Path
	if config.RPCRequestTimeout <= config.MutationTimeout {
		return Config{}, fmt.Errorf("ANTNEST_RUNTIME_RPC_TIMEOUT must exceed ANTNEST_RUNTIME_MUTATION_TIMEOUT")
	}
	return config, nil
}

func parseMaintenanceVerifiers(raw string) (deployment.MaintenanceVerifiers, error) {
	if strings.TrimSpace(raw) == "" {
		return deployment.MaintenanceVerifiers{}.Normalize()
	}
	if !strings.HasPrefix(strings.TrimSpace(raw), "{") {
		return deployment.MaintenanceVerifiers{}, fmt.Errorf("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS must be a JSON object")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	var parsed deployment.MaintenanceVerifiers
	if err := decoder.Decode(&parsed); err != nil {
		return deployment.MaintenanceVerifiers{}, fmt.Errorf("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return deployment.MaintenanceVerifiers{}, fmt.Errorf("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS must be one JSON object")
	}
	if parsed.Keys == nil {
		return deployment.MaintenanceVerifiers{}, fmt.Errorf("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS requires a keys array")
	}
	normalized, err := parsed.Normalize()
	if err != nil {
		return deployment.MaintenanceVerifiers{}, fmt.Errorf("ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: %w", err)
	}
	return normalized, nil
}

func runtimeTelemetryEnvironment(lookup func(string) string) map[string]string {
	result := make(map[string]string)
	result["ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT"] = strings.ToLower(valueOr(lookup, "ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "false"))
	for _, key := range []string{
		"OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER",
		"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	} {
		if value := strings.TrimSpace(lookup("ANTNEST_RUNTIME_" + key)); value != "" {
			result[key] = value
		} else if value := strings.TrimSpace(lookup(key)); value != "" {
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
