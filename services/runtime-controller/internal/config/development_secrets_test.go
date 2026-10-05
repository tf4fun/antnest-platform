package config

import (
	"strings"
	"testing"
)

func TestLoadRejectsPublishedDevelopmentPassword(t *testing.T) {
	for _, dsn := range []string{
		"postgres://rc:antnest-runtime-controller-dev@postgres/rc",
		"postgres://rc:%61ntnest-runtime-controller-dev@postgres/rc",
		"postgres://rc@postgres/rc?password=antnest-runtime-controller-dev",
		"host=postgres user=rc password='antnest-runtime-controller-dev' dbname=rc",
	} {
		env := testEnvironment(t, map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": dsn, "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "fixture-management"})
		if _, err := Load(env); err == nil || !strings.Contains(err.Error(), "ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL") {
			t.Errorf("expected named rejection, got %v", err)
		}
	}
}

func TestPublicDevelopmentOptInAndRemovedToken(t *testing.T) {
	values := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://rc:antnest-runtime-controller-dev@postgres/rc", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "fixture-management", "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS": "true"}
	cfg, err := Load(testEnvironment(t, values))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cfg.Authentication.CloseIdleConnections)
	if len(cfg.DevelopmentSecretWarnings) != 1 || cfg.DevelopmentSecretWarnings[0] != "ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL" {
		t.Fatalf("warnings: %v", cfg.DevelopmentSecretWarnings)
	}
	values["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "antnest-skill-registry-local-development-token"
	if _, err := Load(testEnvironment(t, values)); err == nil {
		t.Fatal("opt-in restored removed token")
	}
	delete(values, "ANTNEST_SKILL_REGISTRY_API_TOKEN")
	for _, value := range []string{"TRUE", "1", " true", "true ", "False"} {
		values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = value
		if _, err := Load(testEnvironment(t, values)); err == nil {
			t.Errorf("accepted opt-in %q", value)
		}
	}
}
