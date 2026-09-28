package main

import "testing"

func TestLoadConfig(t *testing.T) {
	values := map[string]string{
		"ANTNEST_SKILL_REGISTRY_DATABASE_URL": "postgres://registry@example/registry",
		"ANTNEST_SKILL_REGISTRY_API_TOKEN":    "0123456789abcdef0123456789abcdef",
	}
	lookup := func(key string) string { return values[key] }
	cfg, err := loadConfig(lookup)
	if err != nil || cfg.listenAddress != ":8080" {
		t.Fatalf("config=%#v err=%v", cfg, err)
	}
	delete(values, "ANTNEST_SKILL_REGISTRY_API_TOKEN")
	if _, err := loadConfig(lookup); err == nil {
		t.Fatal("accepted missing service token")
	}
}
