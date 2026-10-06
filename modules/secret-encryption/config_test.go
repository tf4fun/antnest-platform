package secretencryption

import (
	"bytes"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestLoadConfigChecksEveryKeyWithOwningVariable(t *testing.T) {
	const prefix = "ANTNEST_TEST"
	first, second := testKey(1), testKey(2)
	encoded := base64.StdEncoding.EncodeToString(first)
	for _, test := range []struct {
		name, single, ring, active, variable string
		keys                                 map[string][]byte
	}{
		{"single", " " + encoded + " ", "", LegacyKeyID, prefix + "_ENCRYPTION_KEY", map[string][]byte{LegacyKeyID: first}},
		{"ring", "", "old:" + encoded + ",new:" + base64.StdEncoding.EncodeToString(second), "new", prefix + "_ENCRYPTION_KEYS", map[string][]byte{"old": first, "new": second}},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{
				prefix + "_ENCRYPTION_KEY":        test.single,
				prefix + "_ENCRYPTION_KEYS":       test.ring,
				prefix + "_ENCRYPTION_ACTIVE_KID": "",
			}
			if test.ring != "" {
				values[prefix+"_ENCRYPTION_ACTIVE_KID"] = test.active
			}
			reads := make(map[string]int)
			checked := make(map[string]int)
			config, err := LoadConfig(func(name string) string {
				reads[name]++
				return values[name]
			}, prefix, func(variable string, key []byte) error {
				if variable != test.variable {
					t.Fatalf("policy variable = %s, want %s", variable, test.variable)
				}
				checked[string(key)]++
				return nil
			})
			if err != nil || config.ActiveKID != test.active || !reflect.DeepEqual(config.Keys, test.keys) {
				t.Fatalf("loaded key configuration does not match requested mode: %v", err)
			}
			if len(reads) != len(values) {
				t.Fatal("loader read unrelated environment variables")
			}
			for name := range values {
				if reads[name] != 1 {
					t.Fatalf("read %s %d times", name, reads[name])
				}
			}
			if len(checked) != len(test.keys) {
				t.Fatal("policy did not check every configured key")
			}
			for _, key := range test.keys {
				if checked[string(key)] != 1 {
					t.Fatal("configured key was not checked exactly once")
				}
			}
		})
	}
}

func TestLoadConfigRejectsMalformedConfigurationBeforePolicy(t *testing.T) {
	const prefix = "ANTNEST_TEST"
	key := base64.StdEncoding.EncodeToString(testKey(1))
	for _, test := range []struct{ name, single, ring, active string }{
		{"missing", "", "", ""},
		{"mixed", key, "kid1:" + key, "kid1"},
		{"unknown active", "", "kid1:" + key, "kid2"},
		{"active whitespace", "", "kid1:" + key, " kid1"},
		{"invalid later member", "", "kid1:" + key + ",kid2:private-invalid-key", "kid1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := map[string]string{
				prefix + "_ENCRYPTION_KEY":        test.single,
				prefix + "_ENCRYPTION_KEYS":       test.ring,
				prefix + "_ENCRYPTION_ACTIVE_KID": test.active,
			}
			config, err := LoadConfig(func(name string) string { return values[name] }, prefix, func(string, []byte) error {
				t.Fatal("policy invoked for a malformed configuration")
				return nil
			})
			if err == nil || config.Keys != nil || config.ActiveKID != "" {
				t.Fatal("malformed configuration returned a usable key ring")
			}
			if !strings.Contains(err.Error(), prefix+"_ENCRYPTION_KEY") || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "private-invalid-key") {
				t.Fatal("configuration error lost its variable name or exposed key material")
			}
		})
	}
}

func TestLoadConfigPropagatesSingleAndDecryptOnlyKeyPolicyFailure(t *testing.T) {
	const prefix = "ANTNEST_TEST"
	rejected := bytes.Repeat([]byte{0}, 32)
	encoded := base64.StdEncoding.EncodeToString(rejected)
	policyError := errors.New("owning service rejected a development key")
	for _, mode := range []string{"single", "decrypt-only"} {
		t.Run(mode, func(t *testing.T) {
			variable := prefix + "_ENCRYPTION_KEY"
			values := map[string]string{variable: encoded}
			if mode == "decrypt-only" {
				variable = prefix + "_ENCRYPTION_KEYS"
				values = map[string]string{
					variable:                          "old:" + encoded + ",new:" + base64.StdEncoding.EncodeToString(testKey(1)),
					prefix + "_ENCRYPTION_ACTIVE_KID": "new",
				}
			}
			config, err := LoadConfig(func(name string) string { return values[name] }, prefix, func(name string, key []byte) error {
				if name != variable {
					t.Fatalf("wrong policy variable: %s", name)
				}
				if bytes.Equal(key, rejected) {
					return policyError
				}
				return nil
			})
			if !errors.Is(err, policyError) || config.Keys != nil || config.ActiveKID != "" {
				t.Fatal("policy failure did not reject the complete configuration")
			}
		})
	}
}

func TestLoadConfigRequiresLookupAndPolicy(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(testKey(1))
	lookup := func(string) string { return key }
	check := func(string, []byte) error { return nil }
	for _, test := range []struct {
		name   string
		lookup func(string) string
		check  func(string, []byte) error
	}{
		{"missing lookup", nil, check},
		{"missing policy", lookup, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := LoadConfig(test.lookup, "ANTNEST_TEST", test.check); !errors.Is(err, ErrConfiguration) {
				t.Fatalf("missing required dependency: %v", err)
			}
		})
	}
}
