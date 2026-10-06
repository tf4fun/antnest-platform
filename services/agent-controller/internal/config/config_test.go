package config

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadRequiresDatabaseAndCanonicalEncryptionKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	loaded, err := loadBusinessConfig(t, func(key string) string {
		if key == "ANTNEST_AGENT_CONTROLLER_RUN_ADMISSION_TTL" {
			t.Fatal("Controller must not configure execution admission")
		}
		return values[key]
	})
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if loaded.ListenAddress != ":8080" || loaded.ShutdownTimeout != 15*time.Second ||
		loaded.DependencyTimeout != 150*time.Second || loaded.DrainTimeout != 5*time.Minute ||
		loaded.ObservationPollInterval != 2*time.Second ||
		loaded.IdentityRevocationPollInterval != 2*time.Second {
		t.Fatalf("defaults = %+v", loaded)
	}
	if loaded.RuntimeEgressURL != values["ANTNEST_RUNTIME_EGRESS_URL"] ||
		loaded.RuntimeControllerURL != values["ANTNEST_RUNTIME_CONTROLLER_URL"] ||
		loaded.IdentityServiceURL != values["ANTNEST_IDENTITY_SERVICE_URL"] {
		t.Fatalf("dependency URLs = %+v", loaded)
	}
	if len(loaded.Encryption.Keys["local-v1"]) != 32 {
		t.Fatalf("encryption key length = %d", len(loaded.Encryption.Keys["local-v1"]))
	}

	delete(values, "ANTNEST_AGENT_CONTROLLER_DATABASE_URL")
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing database URL was accepted")
	}
}

func TestSkillRegistryUsesPerReceiverCredentials(t *testing.T) {
	values := map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://agent-acp-service:8081",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
		"ANTNEST_SKILL_REGISTRY_URL":              "http://skill-registry:8080",
	}
	lookup := func(key string) string { return values[key] }
	loaded, err := loadBusinessConfig(t, lookup)
	if err != nil || loaded.SkillRegistryURL != values["ANTNEST_SKILL_REGISTRY_URL"] {
		t.Fatalf("Registry URL without legacy token rejected: %v", err)
	}
	for _, legacy := range []string{"secret", " "} {
		values["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = legacy
		if _, err := loadBusinessConfig(t, lookup); err == nil {
			t.Fatal("legacy shared token accepted")
		}
	}
	delete(values, "ANTNEST_SKILL_REGISTRY_API_TOKEN")
	delete(values, "ANTNEST_SKILL_REGISTRY_URL")
	loaded, err = loadBusinessConfig(t, lookup)
	if err != nil || loaded.SkillRegistryURL != "" {
		t.Fatalf("optional Registry = %v", err)
	}
}

func TestLoadRejectsInvalidEncryptionKeyAndDuration(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": "not-base64",
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid encryption key was accepted")
	}
	values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	values["ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT"] = "0s"
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive shutdown timeout was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT")
	values["ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT"] = "not-a-duration"
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid drain timeout was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_DRAIN_TIMEOUT")
	values["ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL"] = "0s"
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive Runtime observation poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL")
	values["ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL"] = "0s"
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive identity revocation poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL")
	delete(values, "ANTNEST_RUNTIME_EGRESS_URL")
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing Runtime Egress URL was accepted")
	}
	values["ANTNEST_RUNTIME_EGRESS_URL"] = "http://runtime-egress:8081"
	delete(values, "ANTNEST_IDENTITY_SERVICE_URL")
	if _, err := loadBusinessConfig(t, func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing Identity Service URL was accepted")
	}
}
