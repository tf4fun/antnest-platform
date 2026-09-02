package config

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadRequiresDatabaseAndCanonicalEncryptionKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	loaded, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if loaded.ListenAddress != ":8080" || loaded.ShutdownTimeout != 15*time.Second ||
		loaded.DependencyTimeout != 150*time.Second || loaded.DrainTimeout != 5*time.Minute ||
		loaded.RunAdmissionTTL != 30*time.Minute ||
		loaded.RecoveryPollInterval != 2*time.Second ||
		loaded.ObservationPollInterval != 2*time.Second ||
		loaded.RecoveryAttemptTimeout != 10*time.Minute+5*time.Second ||
		loaded.RecoveryLeaseDuration != 10*time.Minute+35*time.Second ||
		loaded.RecoveryRetryMax != time.Minute {
		t.Fatalf("defaults = %+v", loaded)
	}
	if loaded.RuntimeEgressURL != values["ANTNEST_RUNTIME_EGRESS_URL"] ||
		loaded.RuntimeControllerURL != values["ANTNEST_RUNTIME_CONTROLLER_URL"] ||
		loaded.IdentityServiceURL != values["ANTNEST_IDENTITY_SERVICE_URL"] {
		t.Fatalf("dependency URLs = %+v", loaded)
	}
	if len(loaded.EncryptionKey) != 32 {
		t.Fatalf("encryption key length = %d", len(loaded.EncryptionKey))
	}

	delete(values, "ANTNEST_AGENT_CONTROLLER_DATABASE_URL")
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing database URL was accepted")
	}
}

func TestLoadRejectsInvalidEncryptionKeyAndDuration(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": "not-base64",
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid encryption key was accepted")
	}
	values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 32))
	values["ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT"] = "0s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive shutdown timeout was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT")
	values["ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT"] = "not-a-duration"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid drain timeout was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT")
	values["ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL"] = "-1s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive Run admission TTL was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL")
	values["ANTNEST_AGENT_CONTROLLER_RECOVERY_POLL_INTERVAL"] = "not-a-duration"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid recovery poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_RECOVERY_POLL_INTERVAL")
	values["ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL"] = "0s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive Runtime observation poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL")
	delete(values, "ANTNEST_RUNTIME_EGRESS_URL")
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing Runtime Egress URL was accepted")
	}
	values["ANTNEST_RUNTIME_EGRESS_URL"] = "http://runtime-egress:8081"
	delete(values, "ANTNEST_IDENTITY_SERVICE_URL")
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing Identity Service URL was accepted")
	}
}
