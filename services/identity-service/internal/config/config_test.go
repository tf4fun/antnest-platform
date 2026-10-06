package config

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestLoadAppliesIdentityDefaultsAndBootstrap(t *testing.T) {
	values := validEnvironment()
	config, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if config.ListenAddress != ":8080" || config.TokenTTL != 12*time.Hour ||
		config.OIDCSessionTTL != 10*time.Minute || len(config.Encryption.Keys["local-v1"]) != 32 {
		t.Fatalf("config = %+v", config)
	}
	if config.Bootstrap.OrganizationSlug != "engineering" || config.Bootstrap.AdminEmail != "admin@example.com" {
		t.Fatalf("bootstrap = %+v", config.Bootstrap)
	}
}

func TestLoadRejectsPartialBootstrapAndNoncanonicalKey(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{name: "partial bootstrap", mutate: func(values map[string]string) { delete(values, "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD") }},
		{name: "short key", mutate: func(values map[string]string) {
			values["ANTNEST_IDENTITY_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 31))
		}},
		{name: "noncanonical key", mutate: func(values map[string]string) {
			values["ANTNEST_IDENTITY_ENCRYPTION_KEY"] = strings.TrimRight(values["ANTNEST_IDENTITY_ENCRYPTION_KEY"], "=")
		}},
		{name: "public HTTP", mutate: func(values map[string]string) {
			values["ANTNEST_IDENTITY_PUBLIC_BASE_URL"] = "http://identity.example.com"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := validEnvironment()
			test.mutate(values)
			if _, err := Load(func(key string) string { return values[key] }); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"ANTNEST_IDENTITY_DATABASE_URL":       "postgres://identity:identity@postgres/identity",
		"ANTNEST_IDENTITY_ENCRYPTION_KEY":     base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_IDENTITY_PUBLIC_BASE_URL":    "https://identity.example.com",
		"ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG": "engineering",
		"ANTNEST_BOOTSTRAP_ORGANIZATION_NAME": "Engineering",
		"ANTNEST_BOOTSTRAP_ADMIN_EMAIL":       "admin@example.com",
		"ANTNEST_BOOTSTRAP_ADMIN_PASSWORD":    "correct horse battery staple",
	}
}
