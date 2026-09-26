package postgres

import (
	"regexp"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"testing"
)

func TestRuntimeReconciliationUsesStableTypedEventID(t *testing.T) {
	snapshot := ports.RuntimeEnvironmentSnapshot{AgentID: "agent-1", RuntimeRevision: "runtime-1", RuntimeExecutionID: "process-1"}
	first := runtimeReconciliationEventID(snapshot)
	if !regexp.MustCompile(`^event_[0-9a-f]{32}$`).MatchString(first) {
		t.Fatalf("event ID = %q", first)
	}
	if first != runtimeReconciliationEventID(snapshot) {
		t.Fatal("retry changed event identity")
	}
	snapshot.RuntimeExecutionID = "process-2"
	if first == runtimeReconciliationEventID(snapshot) {
		t.Fatal("different incarnation reused event identity")
	}
}
