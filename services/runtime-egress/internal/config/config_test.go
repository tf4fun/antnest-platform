package config

import "testing"

func TestLoadRequiresTokenSecret(t *testing.T) {
	_, err := Load(func(string) string { return "" })
	if err == nil {
		t.Fatal("Load() error = nil, want token secret error")
	}
}

func TestLoadDefaults(t *testing.T) {
	configuration, err := Load(func(key string) string {
		if key == "ANTNEST_RUNTIME_TOKEN_SECRET" {
			return "0123456789abcdef0123456789abcdef"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if configuration.ListenAddress != ":8081" || configuration.RuntimeListenAddress != ":8092" {
		t.Fatalf("unexpected listen defaults: %+v", configuration)
	}
}
