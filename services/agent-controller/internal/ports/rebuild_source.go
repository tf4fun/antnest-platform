package ports

import "soft/antnest-platform/services/agent-controller/internal/domain"

// A configured resource can be managed before any execution has become healthy.
func (record AgentRecord) HasConfiguredRuntime() bool {
	if record.AgentSpecRevisionID == "" || record.RuntimeRevision == "" ||
		(record.FailureCode == "lifecycle_invariant_failed" || record.FailureCode == "legacy_migration_proof_lost") || record.LifecycleState != domain.AgentCreated ||
		record.ActivationState != domain.ActivationEnabled {
		return false
	}
	return (record.ExecutionRevisionID != "" && record.RuntimeExecutionID != "" && record.RuntimeMCPEndpoint != "") ||
		(record.ExecutionRevisionID == "" && record.RuntimeExecutionID == "" && record.RuntimeMCPEndpoint == "")
}

func (source AgentRuntimeSource) MatchesAgent(agent AgentRecord) bool {
	if !agent.HasConfiguredRuntime() || source.Spec.ID != agent.AgentSpecRevisionID ||
		source.Spec.AgentID != agent.AgentID {
		return false
	}
	if source.Execution.ID == "" {
		return agent.ExecutionRevisionID == ""
	}
	expected := agent.ExecutionRevisionID
	if expected == "" {
		expected = agent.LastSuccessfulExecutionRevisionID
	}
	return source.Execution.ID == expected && source.Execution.AgentID == agent.AgentID &&
		source.Execution.AgentSpecRevisionID == source.Spec.ID &&
		source.Execution.RuntimeRevision == agent.RuntimeRevision
}
