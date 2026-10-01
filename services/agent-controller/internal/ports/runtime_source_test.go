package ports

import (
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestRuntimeSourceDoesNotRequirePreviousExecution(t *testing.T) {
	t.Parallel()
	agent := AgentRecord{
		AgentID: "agent-1", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown, AgentSpecRevisionID: "spec-2", RuntimeRevision: "runtime-2",
		LastSuccessfulExecutionRevisionID: "execution-from-spec-1",
	}
	source := AgentRuntimeSource{Spec: AgentSpecRecord{ID: "spec-2", AgentID: "agent-1"}}
	if !source.MatchesAgent(agent) {
		t.Fatal("configured Runtime must be manageable before its first execution")
	}
	agent.LifecycleState, agent.ActivationState, agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeAvailable
	if !source.MatchesAgent(agent) {
		t.Fatal("observed health does not replace configured resource ownership")
	}
	agent.ExecutionRevisionID = "incomplete-binding"
	if source.MatchesAgent(agent) {
		t.Fatal("partially populated execution binding must be rejected")
	}
}

func TestRuntimeSourceRejectsForeignOrStaleExecution(t *testing.T) {
	t.Parallel()
	agent := AgentRecord{
		AgentID: "agent-1", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown, AgentSpecRevisionID: "spec-2", RuntimeRevision: "runtime-2",
		LastSuccessfulExecutionRevisionID: "execution-1",
	}
	source := AgentRuntimeSource{
		Spec:      AgentSpecRecord{ID: "spec-2", AgentID: "agent-1"},
		Execution: ExecutionRecord{ID: "execution-1", AgentID: "agent-1", AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-1"},
	}
	if source.MatchesAgent(agent) {
		t.Fatal("historical execution cannot stand in for the configured Runtime")
	}
}
