package ports

import "soft/antnest-platform/services/agent-controller/internal/domain"

func (record AgentRecord) RebuildSourceExecutionID() string {
	if record.DesiredState != domain.DesiredEnabled || record.IdentityRevoked() ||
		record.AgentSpecRevisionID == "" || record.RuntimeRevision == "" {
		return ""
	}
	if record.LifecycleState == domain.AgentAvailable {
		return record.ExecutionRevisionID
	}
	if record.LifecycleState == domain.AgentUnavailable && record.ExecutionRevisionID == "" &&
		record.RuntimeExecutionID == "" && record.RuntimeMCPEndpoint == "" &&
		record.FailureCode != "lifecycle_invariant_failed" {
		return record.LastSuccessfulExecutionRevisionID
	}
	return ""
}

func (source AgentExecutionSource) MatchesAgent(agent AgentRecord) bool {
	return source.Execution.ID != "" && source.Execution.ID == agent.RebuildSourceExecutionID() &&
		source.Spec.ID == agent.AgentSpecRevisionID && source.Spec.AgentID == agent.AgentID &&
		source.Execution.AgentID == agent.AgentID && source.Execution.AgentSpecRevisionID == source.Spec.ID &&
		source.Execution.RuntimeRevision == agent.RuntimeRevision
}
