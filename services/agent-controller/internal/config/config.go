package config

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

var legacyVerifierKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type LegacyExportVerifierKey struct {
	KeyID     string
	PublicKey ed25519.PublicKey
}

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
	LegacyExportVerifierKeys       []LegacyExportVerifierKey
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
	verifierKeys, err := decodeLegacyExportVerifierKeys(lookup("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS"))
	if err != nil {
		return Config{}, err
	}
	config.LegacyExportVerifierKeys = verifierKeys
	return config, nil
}

func decodeLegacyExportVerifierKeys(raw string) ([]LegacyExportVerifierKey, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	input, err := decodeUniqueJSONObject([]byte(raw))
	if err != nil || len(input) < 1 || len(input) > 2 || input["current"] == nil {
		return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS requires a current key")
	}
	for field := range input {
		if field != "current" && field != "next" {
			return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS has an unknown field")
		}
	}
	decode := func(raw json.RawMessage) (LegacyExportVerifierKey, error) {
		value, err := decodeUniqueJSONObject(raw)
		if err != nil || len(value) != 2 || value["key_id"] == nil || value["public_key"] == nil {
			return LegacyExportVerifierKey{}, fmt.Errorf("verifier entry must contain exactly key_id and public_key")
		}
		var id, encoded string
		if err := json.Unmarshal(value["key_id"], &id); err != nil || !legacyVerifierKeyIDPattern.MatchString(id) {
			return LegacyExportVerifierKey{}, fmt.Errorf("invalid verifier key ID")
		}
		if err := json.Unmarshal(value["public_key"], &encoded); err != nil {
			return LegacyExportVerifierKey{}, fmt.Errorf("invalid Ed25519 public key")
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(decoded) != encoded {
			return LegacyExportVerifierKey{}, fmt.Errorf("invalid Ed25519 public key")
		}
		return LegacyExportVerifierKey{KeyID: id, PublicKey: ed25519.PublicKey(decoded)}, nil
	}
	current, err := decode(input["current"])
	if err != nil {
		return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS: %w", err)
	}
	keys := []LegacyExportVerifierKey{current}
	if raw, present := input["next"]; present {
		next, err := decode(raw)
		if err != nil {
			return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS: %w", err)
		}
		if next.KeyID == current.KeyID || bytes.Equal(next.PublicKey, current.PublicKey) {
			return nil, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS requires distinct keys and IDs")
		}
		keys = append(keys, next)
	}
	return keys, nil
}

func decodeUniqueJSONObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, fmt.Errorf("expected JSON object")
	}
	values := map[string]json.RawMessage{}
	for decoder.More() {
		field, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, ok := field.(string)
		if !ok || values[name] != nil {
			return nil, fmt.Errorf("duplicate JSON field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		values[name] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("trailing JSON content")
	}
	return values, nil
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
