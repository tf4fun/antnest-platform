package application

import (
	"regexp"
	"testing"
)

func assertResourceID(t *testing.T, kind, id string) {
	t.Helper()
	if !regexp.MustCompile("^" + kind + "_[0-9a-f]{32}$").MatchString(id) {
		t.Fatalf("%s resource ID = %q", kind, id)
	}
}

func TestAgentIDDerivationIsUnchanged(t *testing.T) {
	if id := derivedID("agent", "request-create-agent"); id != "agent_e94c17c429dc4904d167d643309872e5" {
		t.Fatalf("Agent ID derivation changed: %q", id)
	}
}
