package config

import (
	"encoding/base64"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	maximumLifecycleDependencyCalls = 10
	maximumRecoveryPhaseCalls       = 4
	recoveryFinalizationGrace       = 30 * time.Second
)

type Config struct {
	ListenAddress          string
	DatabaseURL            string
	EncryptionKey          []byte
	RuntimeEgressURL       string
	RuntimeControllerURL   string
	DependencyTimeout      time.Duration
	DrainTimeout           time.Duration
	RunAdmissionTTL        time.Duration
	LifecycleTimeout       time.Duration
	RecoveryPollInterval   time.Duration
	RecoveryStaleAfter     time.Duration
	RecoveryAttemptTimeout time.Duration
	RecoveryLeaseDuration  time.Duration
	RecoveryRetryMax       time.Duration
	ShutdownTimeout        time.Duration
}

func Load(lookup func(string) string) (Config, error) {
	if lookup == nil {
		return Config{}, fmt.Errorf("environment lookup is required")
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
	lifecycleTimeout, err := durationBudget(
		dependencyTimeout, maximumLifecycleDependencyCalls, 30*time.Second,
		"lifecycle timeout",
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
	runAdmissionTTL, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL"),
		"ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL",
		30*time.Minute,
	)
	if err != nil {
		return Config{}, err
	}
	recoveryPollInterval, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_RECOVERY_POLL_INTERVAL"),
		"ANTNEST_AGENT_CONTROLLER_RECOVERY_POLL_INTERVAL",
		2*time.Second,
	)
	if err != nil {
		return Config{}, err
	}
	recoveryAttemptTimeout, err := durationBudget(
		dependencyTimeout, maximumRecoveryPhaseCalls, 5*time.Second,
		"lifecycle recovery attempt timeout",
	)
	if err != nil {
		return Config{}, err
	}
	recoveryLeaseDuration := recoveryAttemptTimeout + recoveryFinalizationGrace
	minimumRecoveryStaleAfter := lifecycleTimeout + recoveryFinalizationGrace
	if recoveryLeaseDuration > minimumRecoveryStaleAfter {
		minimumRecoveryStaleAfter = recoveryLeaseDuration
	}
	recoveryStaleAfter, err := positiveDuration(
		lookup("ANTNEST_AGENT_CONTROLLER_RECOVERY_STALE_AFTER"),
		"ANTNEST_AGENT_CONTROLLER_RECOVERY_STALE_AFTER",
		minimumRecoveryStaleAfter,
	)
	if err != nil {
		return Config{}, err
	}
	if recoveryStaleAfter < minimumRecoveryStaleAfter {
		return Config{}, fmt.Errorf(
			"ANTNEST_AGENT_CONTROLLER_RECOVERY_STALE_AFTER must cover the online lifecycle timeout and finalization grace",
		)
	}
	config := Config{
		ListenAddress:          strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_LISTEN")),
		DatabaseURL:            strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_DATABASE_URL")),
		RuntimeEgressURL:       strings.TrimSpace(lookup("ANTNEST_RUNTIME_EGRESS_URL")),
		RuntimeControllerURL:   strings.TrimSpace(lookup("ANTNEST_RUNTIME_CONTROLLER_URL")),
		DependencyTimeout:      dependencyTimeout,
		DrainTimeout:           drainTimeout,
		RunAdmissionTTL:        runAdmissionTTL,
		LifecycleTimeout:       lifecycleTimeout,
		RecoveryPollInterval:   recoveryPollInterval,
		RecoveryStaleAfter:     recoveryStaleAfter,
		RecoveryAttemptTimeout: recoveryAttemptTimeout,
		RecoveryLeaseDuration:  recoveryLeaseDuration,
		RecoveryRetryMax:       time.Minute,
		ShutdownTimeout:        shutdownTimeout,
	}
	if config.ListenAddress == "" {
		config.ListenAddress = ":8080"
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
	key, err := decodeEncryptionKey(strings.TrimSpace(lookup("ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY")))
	if err != nil {
		return Config{}, err
	}
	config.EncryptionKey = key
	return config, nil
}

func durationBudget(
	base time.Duration, calls int64, grace time.Duration, name string,
) (time.Duration, error) {
	if calls <= 0 || grace < 0 || base > (time.Duration(math.MaxInt64)-grace)/time.Duration(calls) {
		return 0, fmt.Errorf("%s exceeds the supported duration", name)
	}
	return base*time.Duration(calls) + grace, nil
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
