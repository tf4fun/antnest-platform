package config

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Bootstrap struct {
	OrganizationSlug string
	OrganizationName string
	AdminEmail       string
	AdminPassword    string
}

func (b Bootstrap) Enabled() bool { return b.OrganizationSlug != "" }

type Config struct {
	ListenAddress   string
	DatabaseURL     string
	EncryptionKey   []byte
	PublicBaseURL   string
	TokenTTL        time.Duration
	OIDCSessionTTL  time.Duration
	HTTPTimeout     time.Duration
	ShutdownTimeout time.Duration
	Bootstrap       Bootstrap
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
	}
	tokenTTL, err := duration(lookup, "ANTNEST_IDENTITY_TOKEN_TTL", 12*time.Hour)
	if err != nil {
		return Config{}, err
	}
	sessionTTL, err := duration(lookup, "ANTNEST_IDENTITY_OIDC_SESSION_TTL", 10*time.Minute)
	if err != nil {
		return Config{}, err
	}
	httpTimeout, err := duration(lookup, "ANTNEST_IDENTITY_HTTP_TIMEOUT", 10*time.Second)
	if err != nil {
		return Config{}, err
	}
	shutdownTimeout, err := duration(lookup, "ANTNEST_IDENTITY_SHUTDOWN_TIMEOUT", 15*time.Second)
	if err != nil {
		return Config{}, err
	}
	config := Config{
		ListenAddress: valueOr(lookup, "ANTNEST_IDENTITY_LISTEN", ":8080"),
		DatabaseURL:   strings.TrimSpace(lookup("ANTNEST_IDENTITY_DATABASE_URL")),
		PublicBaseURL: strings.TrimRight(strings.TrimSpace(lookup("ANTNEST_IDENTITY_PUBLIC_BASE_URL")), "/"),
		TokenTTL:      tokenTTL, OIDCSessionTTL: sessionTTL, HTTPTimeout: httpTimeout,
		ShutdownTimeout: shutdownTimeout,
		Bootstrap: Bootstrap{
			OrganizationSlug: strings.TrimSpace(lookup("ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG")),
			OrganizationName: strings.TrimSpace(lookup("ANTNEST_BOOTSTRAP_ORGANIZATION_NAME")),
			AdminEmail:       strings.TrimSpace(lookup("ANTNEST_BOOTSTRAP_ADMIN_EMAIL")),
			AdminPassword:    lookup("ANTNEST_BOOTSTRAP_ADMIN_PASSWORD"),
		},
	}
	if config.DatabaseURL == "" {
		return Config{}, fmt.Errorf("ANTNEST_IDENTITY_DATABASE_URL is required")
	}
	key, err := decodeEncryptionKey(strings.TrimSpace(lookup("ANTNEST_IDENTITY_ENCRYPTION_KEY")))
	if err != nil {
		return Config{}, err
	}
	config.EncryptionKey = key
	if err := validatePublicBaseURL(config.PublicBaseURL); err != nil {
		return Config{}, err
	}
	if err := validateBootstrap(config.Bootstrap); err != nil {
		return Config{}, err
	}
	return config, nil
}

func decodeEncryptionKey(raw string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 || base64.StdEncoding.EncodeToString(decoded) != raw {
		return nil, fmt.Errorf("ANTNEST_IDENTITY_ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes")
	}
	return decoded, nil
}

func validatePublicBaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("ANTNEST_IDENTITY_PUBLIC_BASE_URL must be an absolute HTTP URL without credentials, query, or fragment")
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1" {
		return fmt.Errorf("ANTNEST_IDENTITY_PUBLIC_BASE_URL must use HTTPS outside loopback")
	}
	return nil
}

func validateBootstrap(bootstrap Bootstrap) error {
	values := []string{
		bootstrap.OrganizationSlug, bootstrap.OrganizationName, bootstrap.AdminEmail, bootstrap.AdminPassword,
	}
	populated := 0
	for _, value := range values {
		if value != "" {
			populated++
		}
	}
	if populated != 0 && populated != len(values) {
		return fmt.Errorf("bootstrap organization and administrator variables must be all set or all empty")
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
	value := strings.TrimSpace(lookup(key))
	if value == "" {
		return fallback
	}
	return value
}
