package config

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadRequiresDatabaseAndCanonicalEncryptionKey(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
	loaded, err := Load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if loaded.ListenAddress != ":8080" || loaded.ShutdownTimeout != 15*time.Second {
		t.Fatalf("defaults = %+v", loaded)
	}
	if len(loaded.EncryptionKey) != 32 {
		t.Fatalf("encryption key length = %d", len(loaded.EncryptionKey))
	}

	delete(values, "ANTNEST_AGENT_CONTROLLER_DATABASE_URL")
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing database URL was accepted")
	}
}

func TestLoadRejectsInvalidEncryptionKeyAndDuration(t *testing.T) {
	t.Parallel()

	values := map[string]string{
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://controller:secret@postgres/controller",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": "not-base64",
	}
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("invalid encryption key was accepted")
	}
	values["ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY"] = base64.StdEncoding.EncodeToString(make([]byte, 32))
	values["ANTNEST_AGENT_CONTROLLER_SHUTDOWN_TIMEOUT"] = "0s"
	if _, err := Load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("non-positive shutdown timeout was accepted")
	}
}
