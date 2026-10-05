package main

import "testing"

func TestSourceReaderUsesOwnCredentialFileAndPinnedOrigin(t *testing.T) {
	values := configFixture(t)
	for _, origin := range []string{"http://agent-acp-service:8080", ""} {
		values["ANTNEST_SKILL_REGISTRY_SOURCE_URL"] = origin
		cfg, err := loadConfig(envLookup(values))
		if err != nil {
			t.Fatal(err)
		}
		cfg.clients.CloseIdleConnections()
	}
	for _, origin := range []string{"http://user:pass@host", "http://host/?secret=token", "file:///tmp/source", "http://host/path", "https://host", "http://identity.invalid"} {
		values["ANTNEST_SKILL_REGISTRY_SOURCE_URL"] = origin
		if cfg, err := loadConfig(envLookup(values)); err == nil {
			cfg.clients.CloseIdleConnections()
			t.Fatalf("accepted invalid source origin %q", origin)
		}
	}
}
