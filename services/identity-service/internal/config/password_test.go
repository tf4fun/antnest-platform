package config

import (
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func TestLoadPasswordResourceDefaultsAndOverrides(t *testing.T) {
	values := validEnvironment()
	cfg, err := Load(func(key string) string { return values[key] })
	if err != nil || cfg.Passwords != credentials.DefaultPasswordConfig() {
		t.Fatalf("password defaults=%+v error=%v", cfg.Passwords, err)
	}
	values["ANTNEST_IDENTITY_ARGON2_MEMORY_KIB"] = "96"
	values["ANTNEST_IDENTITY_ARGON2_ITERATIONS"] = "2"
	values["ANTNEST_IDENTITY_ARGON2_PARALLELISM"] = "3"
	values["ANTNEST_IDENTITY_ARGON2_MEMORY_BUDGET_KIB"] = "192"
	values["ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT"] = "4"
	cfg, err = Load(func(key string) string { return values[key] })
	want := credentials.PasswordConfig{Policy: credentials.PasswordPolicy{MemoryKiB: 96, Iterations: 2, Parallelism: 3}, MemoryBudgetKiB: 192, MaxConcurrent: 4}
	if err != nil || cfg.Passwords != want {
		t.Fatalf("password overrides=%+v error=%v", cfg.Passwords, err)
	}
	values["ANTNEST_IDENTITY_ARGON2_MEMORY_KIB"] = "128"
	values["ANTNEST_IDENTITY_ARGON2_PARALLELISM"] = "16"
	values["ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT"] = "64"
	cfg, err = Load(func(key string) string { return values[key] })
	if err != nil || cfg.Passwords.Policy.Parallelism != 16 || cfg.Passwords.MaxConcurrent != 64 {
		t.Fatalf("valid conversion boundaries rejected: %v", err)
	}
}

func TestLoadRejectsUnboundedOrInconsistentPasswordResourcesWithoutEchoingValues(t *testing.T) {
	for _, setting := range []struct {
		key    string
		values []string
	}{
		{"MEMORY_KIB", []string{"0", "7", "15", "1048577", "-1", "4294967296", "private-not-an-integer"}},
		{"ITERATIONS", []string{"0", "11", "1.5", "private-not-an-integer"}},
		{"PARALLELISM", []string{"0", "17", "256", "4294967295", "4294967296", "private-not-an-integer"}},
		{"MEMORY_BUDGET_KIB", []string{"0", "7", "65535", "4194305", "private-not-an-integer"}},
		{"MAX_CONCURRENT", []string{"0", "65", "-1", "2147483648", "4294967295", "4294967296", "private-not-an-integer"}},
	} {
		for _, value := range setting.values {
			t.Run(setting.key+"/"+value, func(t *testing.T) {
				values := validEnvironment()
				values["ANTNEST_IDENTITY_ARGON2_"+setting.key] = value
				_, err := Load(func(key string) string { return values[key] })
				if err == nil {
					t.Fatal("invalid password resource configuration was accepted")
				}
				if strings.Contains(err.Error(), "private-not-an-integer") {
					t.Fatal("configuration error echoed the supplied value")
				}
			})
		}
	}
}
