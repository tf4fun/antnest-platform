package main

import "testing"

func TestSourceReaderConfigurationMustBePairedAndCannotContainUserURLs(t *testing.T) {
	base := map[string]string{"ANTNEST_SKILL_REGISTRY_DATABASE_URL": "postgres://registry@example/registry", "ANTNEST_SKILL_REGISTRY_API_TOKEN": "0123456789abcdef0123456789abcdef"}
	check := func(url, token string) error {
		base["ANTNEST_SKILL_REGISTRY_SOURCE_URL"] = url
		base["ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN"] = token
		_, err := loadConfig(func(k string) string { return base[k] })
		return err
	}
	token := "source-reader-token-at-least-32-bytes"
	if err := check("http://agent-acp-service:8080", token); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{"http://agent-acp-service:8080", ""}, {"", token}, {"http://user:pass@host", token}, {"http://host/?secret=token", token}, {"file:///tmp/source", token}, {"http://host/path", token}, {"http://host", "short"}} {
		if err := check(pair[0], pair[1]); err == nil {
			t.Fatalf("accepted invalid source configuration %q", pair[0])
		}
	}
}
