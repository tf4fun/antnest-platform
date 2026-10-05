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

func loadEncryption(lookup func(string) string, policy *devsecrets.Policy) (secretencryption.Config, error) {
	const prefix = "ANTNEST_AGENT_CONTROLLER"
	config, err := secretencryption.Parse(lookup(prefix+"_ENCRYPTION_KEY"), lookup(prefix+"_ENCRYPTION_KEYS"), lookup(prefix+"_ENCRYPTION_ACTIVE_KID"))
	if err != nil {
		return secretencryption.Config{}, fmt.Errorf("%s_ENCRYPTION_KEY or ENCRYPTION_KEYS/ENCRYPTION_ACTIVE_KID must define one canonical 32-byte key configuration", prefix)
	}
	variable := prefix + "_ENCRYPTION_KEYS"
	if lookup(variable) == "" {
		variable = prefix + "_ENCRYPTION_KEY"
	}
	for _, key := range config.Keys {
		if err := policy.CheckKey(variable, key); err != nil {
			return secretencryption.Config{}, err
		}
	}
	return config, nil
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
	config.Encryption, err = loadEncryption(lookup, policy)
	if err != nil {
		return RekeyConfig{}, err
	}
	if err := policy.CheckDatabaseURL("ANTNEST_AGENT_CONTROLLER_DATABASE_URL", config.DatabaseURL); err != nil {
		return RekeyConfig{}, err
	}
	config.DevelopmentSecretWarnings = policy.Warnings()
	return config, nil
}
