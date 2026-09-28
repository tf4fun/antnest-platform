package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Config struct {
	ListenAddress          string
	IdentityURL            string
	AgentControllerURL     string
	AgentACPURL            string
	SkillRegistryURL       string
	SkillRegistryToken     string
	DefaultRuntimeImageRef string
	DependencyTimeout      time.Duration
	ShutdownTimeout        time.Duration
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	dependencyTimeout, err := duration(lookup, "ANTNEST_ADMIN_DEPENDENCY_TIMEOUT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	shutdownTimeout, err := duration(lookup, "ANTNEST_ADMIN_SHUTDOWN_TIMEOUT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress:          valueOr(lookup, "ANTNEST_ADMIN_CONSOLE_LISTEN", ":8080"),
		IdentityURL:            strings.TrimSpace(lookup("ANTNEST_IDENTITY_SERVICE_URL")),
		AgentControllerURL:     strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_URL")),
		AgentACPURL:            strings.TrimSpace(lookup("ANTNEST_AGENT_ACP_SERVICE_URL")),
		SkillRegistryURL:       strings.TrimSpace(lookup("ANTNEST_SKILL_REGISTRY_URL")),
		SkillRegistryToken:     lookup("ANTNEST_SKILL_REGISTRY_API_TOKEN"),
		DefaultRuntimeImageRef: strings.TrimSpace(lookup("ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF")),
		DependencyTimeout:      dependencyTimeout,
		ShutdownTimeout:        shutdownTimeout,
	}
	if err := serviceURL("ANTNEST_IDENTITY_SERVICE_URL", config.IdentityURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_AGENT_CONTROLLER_URL", config.AgentControllerURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_AGENT_ACP_SERVICE_URL", config.AgentACPURL); err != nil {
		return Config{}, err
	}
	if config.SkillRegistryURL != "" {
		if err := serviceURL("ANTNEST_SKILL_REGISTRY_URL", config.SkillRegistryURL); err != nil {
			return Config{}, err
		}
		if len(config.SkillRegistryToken) < 32 || strings.TrimSpace(config.SkillRegistryToken) != config.SkillRegistryToken {
			return Config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_API_TOKEN must be at least 32 non-whitespace bytes")
		}
	} else if config.SkillRegistryToken != "" {
		return Config{}, fmt.Errorf("ANTNEST_SKILL_REGISTRY_URL is required when Registry token is configured")
	}
	return config, nil
}

func serviceURL(name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%s must be an absolute HTTP URL", name)
	}
	return nil
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
	if value := strings.TrimSpace(lookup(key)); value != "" {
		return value
	}
	return fallback
}
