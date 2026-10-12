package e2e

import (
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func testPasswordEngine(t *testing.T) *credentials.Engine {
	t.Helper()
	engine, err := credentials.NewEngine(credentials.DefaultPasswordConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(engine.Close)
	return engine
}
