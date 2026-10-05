// Package secretencryption implements versioned stored-secret envelopes.
package secretencryption

import (
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
)

const LegacyKeyID = "local-v1"

var (
	ErrConfiguration  = errors.New("invalid encryption key configuration")
	ErrUnknownKey     = errors.New("encryption key ID is unavailable")
	ErrAuthentication = errors.New("stored-secret authentication failed")
	ErrMetadata       = errors.New("invalid stored-secret metadata")
	keyIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

type Config struct {
	ActiveKID string
	Keys      map[string][]byte
}

// Parse never includes raw configuration or key material in errors.
func Parse(single, entries, active string) (Config, error) {
	config := Config{ActiveKID: active, Keys: make(map[string][]byte)}
	if entries == "" {
		if active != "" {
			return Config{}, ErrConfiguration
		}
		key, err := decodeKey(strings.TrimSpace(single))
		if err != nil {
			return Config{}, err
		}
		config.ActiveKID, config.Keys[LegacyKeyID] = LegacyKeyID, key
		return config, nil
	}
	if single != "" || !keyIDPattern.MatchString(active) {
		return Config{}, ErrConfiguration
	}
	for _, entry := range strings.Split(entries, ",") {
		kid, encoded, found := strings.Cut(entry, ":")
		if !found || !keyIDPattern.MatchString(kid) {
			return Config{}, ErrConfiguration
		}
		if _, exists := config.Keys[kid]; exists {
			return Config{}, ErrConfiguration
		}
		key, err := decodeKey(encoded)
		if err != nil {
			return Config{}, err
		}
		config.Keys[kid] = key
	}
	if _, exists := config.Keys[active]; !exists {
		return Config{}, ErrConfiguration
	}
	return config, nil
}

func decodeKey(encoded string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != encoded {
		return nil, ErrConfiguration
	}
	return key, nil
}
