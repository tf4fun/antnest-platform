package devsecrets

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"testing"
)

func TestSharedContract(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/platform/development-secrets.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Published []string `json:"published_values"`
		Disabled  []string `json:"disabled_values"`
		Invalid   []string `json:"invalid_values"`
		Enabled   string   `json:"enabled_value"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	for _, value := range contract.Invalid {
		if _, err := New(value); err == nil {
			t.Errorf("accepted invalid opt-in %q", value)
		}
	}
	for _, value := range append(contract.Disabled, contract.Enabled) {
		policy, err := New(value)
		if err != nil {
			t.Fatal(err)
		}
		for _, published := range contract.Published {
			err := policy.CheckValue("SECRET", published)
			if value == contract.Enabled {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || strings.Contains(err.Error(), published) {
				t.Fatalf("expected redacted rejection, got %v", err)
			}
		}
		if err := policy.CheckValue("PRIVATE", "independent-random-password"); err != nil {
			t.Fatal(err)
		}
		if value == contract.Enabled && len(policy.Warnings()) != 1 {
			t.Fatal("warnings were not deduplicated")
		}
	}
}

func TestKeyAndPasswordChecks(t *testing.T) {
	for _, allow := range []string{"", "true"} {
		policy, err := New(allow)
		if err != nil {
			t.Fatal(err)
		}
		for _, byteValue := range []byte{0, 7, 255} {
			err := policy.CheckKey("KEY", bytes.Repeat([]byte{byteValue}, 32))
			if (err == nil) != (allow == "true") {
				t.Fatalf("unexpected key policy: %v", err)
			}
		}
		if err := policy.CheckKey("RANDOM_KEY", []byte("0123456789abcdef0123456789abcdef")); err != nil {
			t.Fatal(err)
		}
		for _, dsn := range []string{
			"postgres://role:antnest-identity-dev@localhost/db",
			"postgresql://role:%61ntnest-identity-dev@localhost/db",
			"postgres://role:private@localhost/db?password=antnest-identity-dev",
			"host=localhost user=role password='antnest-identity-dev' dbname=db",
		} {
			err := policy.CheckDatabaseURL("DB", dsn)
			if (err == nil) != (allow == "true") {
				t.Fatalf("unexpected database policy: %v", err)
			}
		}
		if err := policy.CheckDatabaseURL("DB", "postgres://role:private@localhost/db"); err != nil {
			t.Fatal(err)
		}
		if err := policy.CheckDatabaseURL("BAD_DB", "postgres://role:secret@%broken/db"); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid DSN not safely rejected")
		}
		if allow == "true" {
			warnings := policy.Warnings()
			if len(warnings) != 2 {
				t.Fatalf("warnings: %v", warnings)
			}
			warnings[0] = "mutated"
			if policy.Warnings()[0] == "mutated" {
				t.Fatal("warnings exposed internal state")
			}
			var output bytes.Buffer
			LogWarnings(slog.New(slog.NewJSONHandler(&output, nil)), policy.Warnings())
			if strings.Count(output.String(), "\"level\":\"WARN\"") != 2 || strings.Contains(output.String(), "antnest-identity-dev") {
				t.Fatal("warnings leaked values or have incorrect level/count")
			}
		}
	}
}
