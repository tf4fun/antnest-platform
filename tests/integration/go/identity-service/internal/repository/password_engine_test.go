package repository

import (
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func testPasswordEngine(t *testing.T) *credentials.Engine {
	t.Helper()
	// Fixture hashes are setup data, so they use a cheap policy. The budget
	// still admits two concurrent hashes, as the production default does.
	// Resource and rehash tests construct their own production-shaped engines.
	config := credentials.DefaultPasswordConfig()
	config.Policy = credentials.PasswordPolicy{MemoryKiB: 32, Iterations: 1, Parallelism: 2}
	config.MemoryBudgetKiB = 64
	engine, err := credentials.NewEngine(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engine.Close)
	return engine
}
