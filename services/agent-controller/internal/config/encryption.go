package config

import (
	"fmt"
	"strings"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/devsecrets"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

type RekeyConfig struct {
	DatabaseURL               string
	Encryption                secretencryption.Config
	DevelopmentSecretWarnings []string
}

// LoadRekey intentionally requires no service clients, listener or Temporal.
func LoadRekey(environment serviceauth.LookupEnv) (RekeyConfig, error) {
	if environment == nil {
		return RekeyConfig{}, fmt.Errorf("environment lookup is required")
	}
	lookup := func(key string) string { value, _ := environment(key); return value }
	policy, err := devsecrets.New(lookup(devsecrets.OptInVariable))
	if err != nil {
		return RekeyConfig{}, err
	}
	config := RekeyConfig{DatabaseURL: strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_DATABASE_URL"))}
	if config.DatabaseURL == "" {
		return RekeyConfig{}, fmt.Errorf("ANTNEST_AGENT_CONTROLLER_DATABASE_URL is required")
	}
	config.Encryption, err = secretencryption.LoadConfig(lookup, "ANTNEST_AGENT_CONTROLLER", policy.CheckKey)
	if err != nil {
		return RekeyConfig{}, err
	}
	if err := policy.CheckDatabaseURL("ANTNEST_AGENT_CONTROLLER_DATABASE_URL", config.DatabaseURL); err != nil {
		return RekeyConfig{}, err
	}
	config.DevelopmentSecretWarnings = policy.Warnings()
	return config, nil
}
