package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func developmentSecretEnvironment() map[string]string {
	return map[string]string{
		"ANTNEST_AGENT_ACP_CONTROL_URL":           "http://acp:8081",
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:private@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"ANTNEST_RUNTIME_EGRESS_URL":              "http://egress:8081",
		"ANTNEST_RUNTIME_CONTROLLER_URL":          "http://rc:8080",
		"ANTNEST_IDENTITY_SERVICE_URL":            "http://identity:8080",
	}
}

func TestLoadRejectsPublishedDevelopmentSecrets(t *testing.T) {
	for _, test := range []struct{ variable, value string }{
		{"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32))},
		{"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32)))},
		{"ANTNEST_AGENT_CONTROLLER_DATABASE_URL", "postgres://controller:antnest-agent-controller-dev@postgres/controller"},
		{"ANTNEST_AGENT_CONTROLLER_DATABASE_URL", "postgres://controller:%61ntnest-agent-controller-dev@postgres/controller"},
		{"ANTNEST_AGENT_CONTROLLER_DATABASE_URL", "host=postgres password=antnest-agent-controller-dev dbname=controller"},
	} {
		values := developmentSecretEnvironment()
		values[test.variable] = test.value
		_, err := loadBusinessConfig(t, func(name string) string { return values[name] })
		if err == nil || !strings.Contains(err.Error(), test.variable) {
			t.Errorf("expected %s rejection, got %v", test.variable, err)
		}
	}
}

func TestPublicDevelopmentOptInWarningsAndLegacyToken(t *testing.T) {
	values := developmentSecretEnvironment()
	values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = "true"
	values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 32))
	values["ANTNEST_AGENT_CONTROLLER_DATABASE_URL"] = "postgres://controller:antnest-agent-controller-dev@postgres/controller"
	cfg, err := loadBusinessConfig(t, func(name string) string { return values[name] })
	if err != nil || len(cfg.DevelopmentSecretWarnings) != 2 {
		t.Fatalf("opt-in: warnings=%v err=%v", cfg.DevelopmentSecretWarnings, err)
	}
	values["ANTNEST_SKILL_REGISTRY_API_TOKEN"] = "antnest-skill-registry-local-development-token"
	if _, err := loadBusinessConfig(t, func(name string) string { return values[name] }); err == nil {
		t.Fatal("development opt-in restored removed bearer")
	}
	delete(values, "ANTNEST_SKILL_REGISTRY_API_TOKEN")
	for _, value := range []string{"TRUE", "1", " true", "true ", "False"} {
		values["ANTNEST_ALLOW_PUBLIC_DEV_SECRETS"] = value
		if _, err := loadBusinessConfig(t, func(name string) string { return values[name] }); err == nil {
			t.Errorf("accepted opt-in %q", value)
		}
	}
}
