package config

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestLoadEncryptionRingWithoutSingleKey(t *testing.T) {
	values := validEnvironment()
	key := values["ANTNEST_IDENTITY_ENCRYPTION_KEY"]
	delete(values, "ANTNEST_IDENTITY_ENCRYPTION_KEY")
	values["ANTNEST_IDENTITY_ENCRYPTION_KEYS"] = "kid1:" + key + ",kid2:" + key
	values["ANTNEST_IDENTITY_ENCRYPTION_ACTIVE_KID"] = "kid2"
	if _, err := Load(func(name string) string { return values[name] }); err != nil {
		t.Fatalf("configured ring was rejected: %v", err)
	}
	values["ANTNEST_IDENTITY_ENCRYPTION_KEYS"] = "kid1:" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0}, 32)) + ",kid2:" + key
	if _, err := Load(func(name string) string { return values[name] }); err == nil {
		t.Fatal("uniform decrypt-only key bypassed admission")
	} else if strings.Contains(err.Error(), key) {
		t.Fatal("error leaked key material")
	}
}

func TestRekeyConfigurationDoesNotRequireBootstrapOrPublicURL(t *testing.T) {
	values := map[string]string{
		"ANTNEST_IDENTITY_DATABASE_URL":          "postgres://identity:private@localhost/identity",
		"ANTNEST_IDENTITY_ENCRYPTION_KEYS":       "kid2:" + base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_IDENTITY_ENCRYPTION_ACTIVE_KID": "kid2",
	}
	loaded, err := LoadRekey(func(name string) (string, bool) {
		if strings.Contains(name, "BOOTSTRAP") || strings.Contains(name, "PUBLIC_BASE_URL") || strings.Contains(name, "SERVICE_AUTH") {
			t.Fatalf("unrelated configuration read: %s", name)
		}
		value, present := values[name]
		return value, present
	})
	if err != nil || loaded.Encryption.ActiveKID != "kid2" {
		t.Fatalf("minimal rekey configuration: %v", err)
	}
}
