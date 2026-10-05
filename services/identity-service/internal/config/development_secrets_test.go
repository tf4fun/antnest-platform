package config

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
)

func TestLoadRejectsPublishedDevelopmentSecrets(t *testing.T) {
	for _, test := range []struct{ name, variable, value string }{
		{"zero key", "ANTNEST_IDENTITY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32))},
		{"repeated key", "ANTNEST_IDENTITY_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))},
		{"published URL password", "ANTNEST_IDENTITY_DATABASE_URL", "postgres://identity:antnest-identity-dev@postgres/identity"},
		{"encoded URL password", "ANTNEST_IDENTITY_DATABASE_URL", "postgres://identity:%61ntnest-identity-dev@postgres/identity"},
		{"query password", "ANTNEST_IDENTITY_DATABASE_URL", "postgres://identity@postgres/identity?password=antnest-identity-dev"},
		{"keyword password", "ANTNEST_IDENTITY_DATABASE_URL", "host=postgres user=identity password='antnest-identity-dev' dbname=identity"},
	} {
		t.Run(test.name, func(t *testing.T) {
			values := safeSecretEnvironment()
			values[test.variable] = test.value
			_, err := Load(func(name string) string { return values[name] })
			if err == nil || !strings.Contains(err.Error(), test.variable) {
				t.Fatalf("expected named rejection for %s, got %v", test.variable, err)
			}
			if strings.Contains(err.Error(), test.value) {
				t.Fatal("secret value leaked in rejection")
			}
		})
	}
}

func safeSecretEnvironment() map[string]string {
	values := validEnvironment()
	values["ANTNEST_IDENTITY_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	return values
}

func TestLoadAcceptsRandomEncryptionKey(t *testing.T) {
	values := safeSecretEnvironment()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	values["ANTNEST_IDENTITY_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(key)
	if _, err := Load(func(name string) string { return values[name] }); err != nil {
		t.Fatal(err)
	}
}

func TestDevelopmentSecretOptInAndBootstrapCreationCheck(t *testing.T) {
	values := safeSecretEnvironment()
	values["ANTNEST_IDENTITY_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 32))
	values["ANTNEST_IDENTITY_DATABASE_URL"] = "postgres://identity:antnest-identity-dev@postgres/identity"
	values["ANTNEST_BOOTSTRAP_ADMIN_PASSWORD"] = "antnest-admin-dev"
	values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = "true"
	cfg, err := Load(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(cfg.DevelopmentSecretWarnings, ",") != "ANTNEST_IDENTITY_ENCRYPTION_KEY,ANTNEST_IDENTITY_DATABASE_URL" {
		t.Fatalf("warnings: %v", cfg.DevelopmentSecretWarnings)
	}
	warnings, err := cfg.Bootstrap.CheckNewAdministratorPassword()
	if err != nil || len(warnings) != 1 || warnings[0] != "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD" {
		t.Fatalf("bootstrap check: %v %v", warnings, err)
	}
	for _, value := range []string{"TRUE", "1", " true", "true ", "False"} {
		values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = value
		if _, err := Load(func(name string) string { return values[name] }); err == nil {
			t.Errorf("accepted opt-in %q", value)
		}
	}
	values = safeSecretEnvironment()
	values["ANTNEST_BOOTSTRAP_ADMIN_PASSWORD"] = "antnest-admin-dev"
	cfg, err = Load(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal("unused bootstrap password must not reject existing administrator:", err)
	}
	if _, err := cfg.Bootstrap.CheckNewAdministratorPassword(); err == nil {
		t.Fatal("accepted published password for new administrator")
	}
}
