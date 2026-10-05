package config

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestLoadEncryptionRingWithoutSingleKey(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	values := map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":                  "http://agent-acp-service:8090",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":          "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEYS":       "kid1:" + key + ",kid2:" + key,
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_ACTIVE_KID": "kid2",
		"ANTNEST_RUNTIME_EGRESS_URL":                     "http://runtime-egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":                 "http://runtime-controller:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":                   "http://identity-service:8080",
	}
	if _, err := loadBusinessConfig(t, func(name string) string { return values[name] }); err != nil {
		t.Fatalf("configured ring was rejected: %v", err)
	}
	values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEYS"] = "kid1:" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0}, 32)) + ",kid2:" + key
	if _, err := loadBusinessConfig(t, func(name string) string { return values[name] }); err == nil {
		t.Fatal("uniform decrypt-only key bypassed admission")
	} else if strings.Contains(err.Error(), key) {
		t.Fatal("error leaked key material")
	}
}

func TestRekeyConfigurationDoesNotReadServiceClients(t *testing.T) {
	values := map[string]string{
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":          "postgres://controller:private@localhost/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEYS":       "kid2:" + base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_ACTIVE_KID": "kid2",
	}
	loaded, err := LoadRekey(func(name string) (string, bool) {
		if strings.Contains(name, "SERVICE_AUTH") || strings.Contains(name, "TEMPORAL") || strings.Contains(name, "CONTROL_URL") {
			t.Fatalf("rekey loaded an unrelated dependency: %s", name)
		}
		value, present := values[name]
		return value, present
	})
	if err != nil || loaded.Encryption.ActiveKID != "kid2" {
		t.Fatalf("minimal rekey config: %v", err)
	}
}
