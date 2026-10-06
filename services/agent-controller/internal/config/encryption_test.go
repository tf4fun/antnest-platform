package config

import (
	"bytes"
	"encoding/base64"
	"reflect"
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

func TestRekeyAndStartupUseSameEncryptionAdmission(t *testing.T) {
	const prefix = "ANTNEST_AGENT_CONTROLLER"
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	uniform := base64.StdEncoding.EncodeToString(make([]byte, 32))
	for _, test := range []struct {
		name, single, ring, active, optIn string
		valid                             bool
		warnings                          []string
	}{
		{name: "trimmed single", single: " " + key + " ", valid: true},
		{name: "ring", ring: "old:" + key + ",new:" + key, active: "new", valid: true},
		{name: "missing"},
		{name: "mixed", single: key, ring: "new:" + key, active: "new"},
		{name: "active whitespace", ring: "new:" + key, active: " new"},
		{name: "uniform single", single: uniform},
		{name: "uniform decrypt-only", ring: "old:" + uniform + ",new:" + key, active: "new"},
		{name: "single opt-in", single: uniform, optIn: "true", valid: true, warnings: []string{prefix + "_ENCRYPTION_KEY"}},
		{name: "ring opt-in deduplicates warnings", ring: "old:" + uniform + ",new:" + uniform, active: "new", optIn: "true", valid: true, warnings: []string{prefix + "_ENCRYPTION_KEYS"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := developmentSecretEnvironment()
			values[prefix+"_ENCRYPTION_KEY"] = test.single
			values[prefix+"_ENCRYPTION_KEYS"] = test.ring
			values[prefix+"_ENCRYPTION_ACTIVE_KID"] = test.active
			values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = test.optIn
			startup, startupErr := loadBusinessConfig(t, func(name string) string { return values[name] })
			rekey, rekeyErr := LoadRekey(func(name string) (string, bool) {
				value, found := values[name]
				return value, found
			})
			if (startupErr == nil) != test.valid || (rekeyErr == nil) != test.valid {
				t.Fatalf("startup/rekey admission differs from expected result: %v / %v", startupErr, rekeyErr)
			}
			if !test.valid {
				if startupErr.Error() != rekeyErr.Error() || !strings.Contains(rekeyErr.Error(), prefix+"_ENCRYPTION_KEY") {
					t.Fatal("startup/rekey lost the same owning-variable rejection")
				}
				if strings.Contains(rekeyErr.Error(), key) || strings.Contains(rekeyErr.Error(), uniform) {
					t.Fatal("admission error exposed key material")
				}
				return
			}
			if !reflect.DeepEqual(startup.Encryption, rekey.Encryption) ||
				!reflect.DeepEqual(startup.DevelopmentSecretWarnings, test.warnings) ||
				!reflect.DeepEqual(rekey.DevelopmentSecretWarnings, test.warnings) {
				t.Fatal("startup/rekey key configuration or policy warnings differ")
			}
		})
	}
}
