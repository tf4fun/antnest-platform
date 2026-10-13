package config

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func loadPasswordConfig(lookup func(string) string) (credentials.PasswordConfig, error) {
	defaults := credentials.DefaultPasswordConfig()
	settings := []struct {
		name     string
		fallback uint32
		minimum  uint32
		maximum  uint32
	}{
		{"MEMORY_KIB", defaults.Policy.MemoryKiB, 8, 1048576},
		{"ITERATIONS", defaults.Policy.Iterations, 1, 10},
		{"PARALLELISM", uint32(defaults.Policy.Parallelism), 1, 16},
		{"MEMORY_BUDGET_KIB", defaults.MemoryBudgetKiB, 8, 4194304},
		{"MAX_CONCURRENT", uint32(defaults.MaxConcurrent), 1, 64},
	}
	values := make([]uint32, len(settings))
	for index, setting := range settings {
		values[index] = setting.fallback
		name := "ANTNEST_IDENTITY_ARGON2_" + setting.name
		raw := strings.TrimSpace(lookup(name))
		if raw == "" {
			continue
		}
		value, err := strconv.ParseUint(raw, 10, 32)
		if err != nil || value < uint64(setting.minimum) || value > uint64(setting.maximum) {
			return credentials.PasswordConfig{}, fmt.Errorf("%s must be an integer between %d and %d", name, setting.minimum, setting.maximum)
		}
		values[index] = uint32(value)
	}
	// Keep policy bounds adjacent to conversions that narrow the parsed width.
	parallelism, maxConcurrent := values[2], values[4]
	if parallelism < 1 || parallelism > 16 {
		return credentials.PasswordConfig{}, fmt.Errorf("ANTNEST_IDENTITY_ARGON2_PARALLELISM must be an integer between 1 and 16")
	}
	if maxConcurrent < 1 || maxConcurrent > 64 {
		return credentials.PasswordConfig{}, fmt.Errorf("ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT must be an integer between 1 and 64")
	}
	config := credentials.PasswordConfig{
		Policy:          credentials.PasswordPolicy{MemoryKiB: values[0], Iterations: values[1], Parallelism: uint8(parallelism)},
		MemoryBudgetKiB: values[3],
		MaxConcurrent:   int(maxConcurrent),
	}
	if err := config.Validate(); err != nil {
		return credentials.PasswordConfig{}, err
	}
	return config, nil
}
