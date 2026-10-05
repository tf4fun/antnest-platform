package main

import (
	"strings"
	"testing"
)

func TestRejectsPublishedDatabasePassword(t *testing.T) {
	for _, dsn := range []string{
		"postgres://registry:antnest-skill-registry-dev@postgres/registry",
		"postgres://registry:%61ntnest-skill-registry-dev@postgres/registry",
		"postgres://registry@postgres/registry?password=antnest-skill-registry-dev",
		"host=postgres password='antnest-skill-registry-dev' dbname=registry",
	} {
		values := configFixture(t)
		values["ANTNEST_SKILL_REGISTRY_DATABASE_URL"] = dsn
		cfg, err := loadConfig(envLookup(values))
		if err == nil {
			cfg.clients.CloseIdleConnections()
		}
		if err == nil || !strings.Contains(err.Error(), "ANTNEST_SKILL_REGISTRY_DATABASE_URL") {
			t.Errorf("expected named rejection, got %v", err)
		}
	}
}

func TestPublicDevelopmentOptInAndRemovedBearers(t *testing.T) {
	values := configFixture(t)
	values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = "true"
	values["ANTNEST_SKILL_REGISTRY_DATABASE_URL"] = "postgres://registry:antnest-skill-registry-dev@postgres/registry"
	cfg, err := loadConfig(envLookup(values))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cfg.clients.CloseIdleConnections)
	if len(cfg.developmentSecretWarnings) != 1 || cfg.developmentSecretWarnings[0] != "ANTNEST_SKILL_REGISTRY_DATABASE_URL" {
		t.Fatalf("warnings: %v", cfg.developmentSecretWarnings)
	}
	for _, name := range []string{"ANTNEST_SKILL_REGISTRY_API_TOKEN", "ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN"} {
		values[name] = "antnest-skill-registry-local-development-token"
		if _, err := loadConfig(envLookup(values)); err == nil {
			t.Fatal("opt-in restored retired bearer")
		}
		delete(values, name)
	}
	for _, value := range []string{"TRUE", "1", " true", "true ", "False"} {
		values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = value
		if _, err := loadConfig(envLookup(values)); err == nil {
			t.Errorf("accepted opt-in %q", value)
		}
	}
}
