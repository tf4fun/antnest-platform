package secretencryption

import "fmt"

// LoadConfig reads one owning service's encryption configuration and checks every
// key, including decrypt-only entries, with the required service-supplied policy.
// Check errors are returned unchanged; the callback must not expose key material.
func LoadConfig(lookup func(string) string, prefix string, checkKey func(string, []byte) error) (Config, error) {
	if lookup == nil || checkKey == nil {
		return Config{}, ErrConfiguration
	}
	single := lookup(prefix + "_ENCRYPTION_KEY")
	entries := lookup(prefix + "_ENCRYPTION_KEYS")
	active := lookup(prefix + "_ENCRYPTION_ACTIVE_KID")
	config, err := Parse(single, entries, active)
	if err != nil {
		return Config{}, fmt.Errorf("%s_ENCRYPTION_KEY or ENCRYPTION_KEYS/ENCRYPTION_ACTIVE_KID must define one canonical 32-byte key configuration", prefix)
	}
	variable := prefix + "_ENCRYPTION_KEYS"
	if entries == "" {
		variable = prefix + "_ENCRYPTION_KEY"
	}
	for _, key := range config.Keys {
		if err := checkKey(variable, key); err != nil {
			return Config{}, err
		}
	}
	return config, nil
}
