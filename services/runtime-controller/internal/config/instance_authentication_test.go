package config

import (
	"strings"
	"testing"
)

func TestInstanceIssuerKeyIsMandatoryBeforeOpeningDependencies(t *testing.T) {
	base := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL": "postgres://unused/db", "ANTNEST_RUNTIME_MANAGEMENT_NETWORK": "management", "ANTNEST_RUNTIME_INSTANCE_KEY_FILE": ""}
	if _, err := Load(testEnvironment(t, base)); err == nil || !strings.Contains(err.Error(), "instance") {
		t.Fatal("missing instance issuer key accepted")
	}
}
