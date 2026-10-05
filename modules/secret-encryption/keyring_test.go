package secretencryption

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func testKey(value byte) []byte {
	key := bytes.Repeat([]byte{value}, 32)
	key[0]++
	return key
}

func TestParseConfiguration(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(testKey(1))
	for _, test := range []struct {
		name, single, ring, active string
		valid                      bool
	}{
		{"legacy", " " + key + " ", "", "", true},
		{"ring", "", "kid1:" + key + ",kid2:" + key, "kid2", true},
		{"missing", "", "", "", false},
		{"mixed", key, "kid1:" + key, "kid1", false},
		{"active only", "", "", "kid1", false},
		{"missing active", "", "kid1:" + key, "", false},
		{"unknown active", "", "kid1:" + key, "kid2", false},
		{"duplicate", "", "kid1:" + key + ",kid1:" + key, "kid1", false},
		{"empty entry", "", "kid1:" + key + ",", "kid1", false},
		{"entry whitespace", "", " kid1:" + key, "kid1", false},
		{"active whitespace", "", "kid1:" + key, " kid1", false},
		{"key whitespace", "", "kid1: " + key, "kid1", false},
		{"short key", "", "kid1:c2hvcnQ=", "kid1", false},
		{"unpadded", "", "kid1:" + strings.TrimRight(key, "="), "kid1", false},
		{"invalid id", "", "bad/id:" + key, "bad/id", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, err := Parse(test.single, test.ring, test.active)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%t error=%v", test.valid, err)
			}
			if err != nil && strings.Contains(err.Error(), key) {
				t.Fatal("configuration error leaked key")
			}
			if test.name == "legacy" && (config.ActiveKID != LegacyKeyID || !bytes.Equal(config.Keys[LegacyKeyID], testKey(1))) {
				t.Fatal("legacy mapping changed")
			}
		})
	}
}
