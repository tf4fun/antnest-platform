package ports

import (
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

// FailedCreateRebuildSourceMatches reports whether the base carries a valid
// failed-create retry source: exactly one failed create that never passed
// network_ensure, never produced execution history or readiness evidence, and
// whose configured spec snapshot can seed a rebuild. It is eligibility proof
// for an initialization retry, never a resource-absence claim.
func FailedCreateRebuildSourceMatches(base AgentLifecycleBase) bool {
	agent := base.Agent
	if agent.LifecycleState != domain.AgentNotCreated || agent.DesiredState != domain.DesiredEnabled ||
		agent.IdentityRevoked() || agent.ActiveOperationRequestID != "" ||
		agent.RuntimeRevision != "" || agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" ||
		agent.ExecutionRevisionID != "" || agent.LastSuccessfulExecutionRevisionID != "" ||
		agent.FailureCode == "lifecycle_cancelled" || agent.FailureCode == "lifecycle_invariant_failed" {
		return false
	}
	operation := base.FailedCreateOperation
	if operation == nil || operation.AgentID != agent.AgentID ||
		operation.Kind != domain.OperationCreate || operation.State != domain.OperationFailed ||
		operation.Phase != domain.PhaseNetworkEnsure ||
		operation.ErrorCode == "lifecycle_cancelled" ||
		operation.ErrorCode == "lifecycle_invariant_failed" ||
		operation.SourceRuntimeRevision != "" || operation.SourceRuntimeAbsent ||
		operation.SourceExecutionRevisionID != "" || operation.SourceSpecRevisionID != "" ||
		operation.TargetSpecRevisionID == "" {
		return false
	}
	if operation.TargetSpecRevisionID != base.ConfiguredSpec.ID ||
		base.ConfiguredSpec.AgentID != agent.AgentID {
		return false
	}
	if agent.AgentSpecRevisionID != "" && agent.AgentSpecRevisionID != operation.TargetSpecRevisionID {
		return false
	}
	return base.SourceExecution.ID == "" && base.NextSpecRevision > base.ConfiguredSpec.Revision
}
