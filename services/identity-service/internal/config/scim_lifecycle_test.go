package config

import (
	"strings"
	"testing"
)

func TestSCIMLifecycleConfigurationRejectsInvalidPolicy(t *testing.T) {
	for _, value := range []string{"yes", "no", "enabled", "2", "tru", "false,true"} {
		t.Run(value, func(t *testing.T) {
			values := validEnvironment()
			values["ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS"] = value
			_, err := Load(func(key string) string { return values[key] })
			if err == nil || !strings.Contains(err.Error(), "ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS") {
				t.Fatalf("invalid issuer-loss policy accepted or misreported: %v", err)
			}
		})
	}
}

func TestSCIMLifecycleConfigurationDefaultsToRevocation(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{{"", true}, {"true", true}, {"false", false}, {"TRUE", true}, {"0", false}, {"1", true}, {" false ", false}} {
		t.Run(tc.value, func(t *testing.T) {
			values := validEnvironment()
			values["ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS"] = tc.value
			config, err := Load(func(key string) string { return values[key] })
			if err != nil || config.SCIMRevokeOnIssuerLoss != tc.want {
				t.Fatalf("issuer-loss policy=%v want=%v err=%v", config.SCIMRevokeOnIssuerLoss, tc.want, err)
			}
		})
	}
}
