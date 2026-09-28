package config

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestLegacyExportVerifierKeyConfiguration(t *testing.T) {
	values := map[string]string{
		"ANTNEST_AGENT_ACP_SERVICE_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	lookup := func(key string) string { return values[key] }
	if config, err := Load(lookup); err != nil || len(config.LegacyExportVerifierKeys) != 0 {
		t.Fatalf("unset verifier keys = %+v, %v", config.LegacyExportVerifierKeys, err)
	}
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	encode := func(value any) string { data, _ := json.Marshal(value); return string(data) }
	values["ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS"] = encode(map[string]any{
		"current": map[string]string{"key_id": "key-1", "public_key": encoded},
	})
	config, err := Load(lookup)
	if err != nil || len(config.LegacyExportVerifierKeys) != 1 || config.LegacyExportVerifierKeys[0].KeyID != "key-1" || !bytes.Equal(config.LegacyExportVerifierKeys[0].PublicKey, bytes.Repeat([]byte{7}, 32)) {
		t.Fatalf("current verifier key = %+v, %v", config.LegacyExportVerifierKeys, err)
	}
	invalid := []string{
		`{}`,
		`{"current":{"key_id":"key-1","public_key":"bad"}}`,
		`{"current":{"key_id":"key-1","public_key":"` + encoded + `"},"next":null}`,
		`{"current":{"key_id":"key-1","key_id":"key-2","public_key":"` + encoded + `"}}`,
		`{"current":{"key_id":"key-1","public_key":"` + encoded + `"},"current":{"key_id":"key-2","public_key":"` + encoded + `"}}`,
		encode(map[string]any{"current": map[string]string{"key_id": "key-1", "public_key": encoded}, "next": map[string]string{"key_id": "key-1", "public_key": encoded}}),
		encode(map[string]any{"current": map[string]string{"key_id": "key-1", "public_key": encoded}, "extra": true}),
		encode(map[string]any{"current": map[string]string{"key_id": "key-1", "public_key": encoded, "extra": "value"}}),
	}
	for _, raw := range invalid {
		values["ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS"] = raw
		if _, err := Load(lookup); err == nil {
			t.Fatalf("invalid verifier configuration accepted: %s", raw)
		}
	}
}

func TestLoadRequiresDatabaseAndCanonicalEncryptionKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_ACP_SERVICE_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
	}
	loaded, err := Load(func(key string) string {
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
	if len(loaded.EncryptionKey) != 32 {
		t.Fatalf("encryption key length = %d", len(loaded.EncryptionKey))
	}

	delete(values, "ANTNEST_AGENT_CONTROLLER_DATABASE_URL")
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing database URL was accepted")
	}
}

func TestSkillRegistryConfigurationMustBePaired(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"ANTNEST_AGENT_ACP_SERVICE_URL":           "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity-service:8080",
		"ANTNEST_SKILL_REGISTRY_URL":              "http://skill-registry:8080",
	}
	lookup := func(key string) string { return values[key] }
	if _, err := Load(lookup); err == nil {
		t.Fatal("URL without token accepted")
	}
	values["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "secret"
	loaded, err := Load(lookup)
	if err != nil || loaded.SkillRegistryURL != values["ANTNEST_SKILL_REGISTRY_URL"] || loaded.SkillRegistryAPIToken != "secret" {
		t.Fatalf("paired Registry configuration = %+v, %v", loaded, err)
	}
	delete(values, "ANTNEST_SKILL_REGISTRY_URL")
	if _, err := Load(lookup); err == nil {
		t.Fatal("token without URL accepted")
	}
}

func TestLoadRejectsInvalidEncryptionKeyAndDuration(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_ACP_SERVICE_URL":           "http://agent-acp-service:8090",
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
	values["ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL"] = "0s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive Runtime observation poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_RUNTIME_OBSERVATION_POLL_INTERVAL")
	values["ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL"] = "0s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive identity revocation poll interval was accepted")
	}
	delete(values, "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL")
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
