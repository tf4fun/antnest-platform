package config

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress      string
	IdentityURL        string
	AdminConsoleURL    string
	AgentUIURL         string
	AgentControllerURL string
	AgentACPURL        string
	CookieSecure       bool
	RequestTimeout     time.Duration
	StreamLease        time.Duration
	LoginWindow        time.Duration
	LoginSourceMax     int
	LoginAccountMax    int
	ShutdownTimeout    time.Duration
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	requestTimeout, err := duration(lookup, "ANTNEST_EDGE_REQUEST_TIMEOUT", 10*time.Second)
	if err != nil {
		return Config{}, err
	}
	streamLease, err := duration(lookup, "ANTNEST_EDGE_STREAM_LEASE", 5*time.Minute)
	if err != nil {
		return Config{}, err
	}
	loginWindow, err := duration(lookup, "ANTNEST_EDGE_LOGIN_WINDOW", 5*time.Minute)
	if err != nil {
		return Config{}, err
	}
	loginSourceMax, err := positiveInteger(lookup, "ANTNEST_EDGE_LOGIN_SOURCE_MAX", 30)
	if err != nil {
		return Config{}, err
	}
	loginAccountMax, err := positiveInteger(lookup, "ANTNEST_EDGE_LOGIN_ACCOUNT_MAX", 10)
	if err != nil {
		return Config{}, err
	}
	shutdownTimeout, err := duration(lookup, "ANTNEST_EDGE_SHUTDOWN_TIMEOUT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	cookieSecure, err := boolean(lookup, "ANTNEST_EDGE_COOKIE_SECURE", true)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress:      valueOr(lookup, "ANTNEST_EDGE_LISTEN", ":8080"),
		IdentityURL:        strings.TrimSpace(lookup("ANTNEST_IDENTITY_SERVICE_URL")),
		AdminConsoleURL:    strings.TrimSpace(lookup("ANTNEST_ADMIN_CONSOLE_URL")),
		AgentUIURL:         strings.TrimSpace(lookup("ANTNEST_AGENT_UI_URL")),
		AgentControllerURL: strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_URL")),
		AgentACPURL:        strings.TrimSpace(lookup("ANTNEST_AGENT_ACP_URL")),
		CookieSecure:       cookieSecure,
		RequestTimeout:     requestTimeout,
		StreamLease:        streamLease,
		LoginWindow:        loginWindow,
		LoginSourceMax:     loginSourceMax,
		LoginAccountMax:    loginAccountMax,
		ShutdownTimeout:    shutdownTimeout,
	}
	if err := serviceURL("ANTNEST_IDENTITY_SERVICE_URL", config.IdentityURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_ADMIN_CONSOLE_URL", config.AdminConsoleURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_AGENT_UI_URL", config.AgentUIURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_AGENT_CONTROLLER_URL", config.AgentControllerURL); err != nil {
		return Config{}, err
	}
	if err := serviceURL("ANTNEST_AGENT_ACP_URL", config.AgentACPURL); err != nil {
		return Config{}, err
	}
	return config, nil
}

func positiveInteger(lookup func(string) string, key string, fallback int) (int, error) {
	raw := strings.TrimSpace(lookup(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
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

func boolean(lookup func(string) string, key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(lookup(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return value, nil
}

func valueOr(lookup func(string) string, key, fallback string) string {
	if value := strings.TrimSpace(lookup(key)); value != "" {
		return value
	}
	return fallback
}
