package repository

import (
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func testPasswordEngine(t *testing.T) *credentials.Engine {
	t.Helper()
	// Fixture hashes are setup data, so they use a cheap policy. The default
	// memory budget still admits verifying stored legacy hashes, which reserve
	// their own policy's memory; two permits match the default's concurrency.
	// Resource tests construct their own production-shaped engines.
	config := credentials.DefaultPasswordConfig()
	config.Policy = credentials.PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}
	config.MaxConcurrent = 2
	engine, err := credentials.NewEngine(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engine.Close)
	return engine
}
