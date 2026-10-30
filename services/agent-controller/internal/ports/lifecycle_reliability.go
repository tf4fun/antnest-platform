package ports

import (
	"context"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type LifecycleReliabilityStore interface {
	TerminateLifecycleOperation(context.Context, TerminateLifecycleOperation) (LifecycleOperationRecord, error)
	ClearLifecycleQuarantine(context.Context, ClearLifecycleQuarantine) (AgentRecord, error)
}

type TerminateLifecycleOperation struct {
	RequestID     string
	Fingerprint   string
	ExpectedPhase domain.OperationPhase
	ErrorCode     string
	ErrorDetail   string
	EventID       string
	TraceID       string
}

type ClearLifecycleQuarantine struct {
	OrganizationID                            string
	ActorPrincipalID                          string
	AgentID                                   string
	ExpectedAggregateSequence                 int64
	ExpectedSpecRevisionID                    string
	ExpectedRuntimeRevision                   string
	ExpectedLastSuccessfulExecutionRevisionID string
	Inspection                                RuntimeInspection
	EventID                                   string
	TraceID                                   string
}

func (record AgentRecord) LifecycleTerminated() bool {
	return record.FailureCode == "lifecycle_cancelled" ||
		record.FailureCode == "phase_deadline_exceeded" ||
		record.FailureCode == "lifecycle_invariant_failed"
}

func CanClearLifecycleQuarantine(base AgentLifecycleBase) bool {
	agent := base.Agent
	if agent.FailureCode != "lifecycle_invariant_failed" ||
		agent.ActiveOperationRequestID != "" ||
		agent.LifecycleState != domain.AgentCreated ||
		agent.IdentityRevoked() ||
		agent.ExecutionRevisionID != "" ||
		agent.RuntimeExecutionID != "" ||
		agent.RuntimeMCPEndpoint != "" ||
		agent.RuntimeRevision == "" {
		return false
	}
	if agent.DesiredState == domain.DesiredEnabled {
		if agent.ActivationState != domain.ActivationEnabled {
			return false
		}
	} else if agent.DesiredState == domain.DesiredDisabled {
		if agent.ActivationState != domain.ActivationDisabled {
			return false
		}
	} else {
		return false
	}
	spec := base.ConfiguredSpec
	if spec.ID == "" || spec.ID != agent.AgentSpecRevisionID || spec.AgentID != agent.AgentID {
		return false
	}
	if agent.LastSuccessfulExecutionRevisionID == "" {
		return base.SourceExecution.ID == ""
	}
	source := base.SourceExecution
	return source.ID == agent.LastSuccessfulExecutionRevisionID &&
		source.AgentID == agent.AgentID &&
		source.AgentSpecRevisionID == spec.ID &&
		source.RuntimeRevision == agent.RuntimeRevision
}

func ValidQuarantineRuntimeInspection(agent AgentRecord, inspection RuntimeInspection) bool {
	if inspection.AgentID != agent.AgentID ||
		inspection.RuntimeRevision != agent.RuntimeRevision ||
		inspection.ObservedAt.IsZero() ||
		inspection.RuntimeExecutionID != "" ||
		inspection.RuntimeEndpoint != "" ||
		inspection.MCPEndpoint != "" {
		return false
	}
	switch inspection.LifecycleState {
	case "disabled":
		if inspection.Phase != "absent" ||
			(inspection.Health != "absent" && inspection.Health != "unhealthy") {
			return false
		}
	case "failed":
		if inspection.Phase != "exited" || inspection.Health != "unhealthy" {
			return false
		}
	case "deleted":
		if inspection.Phase != "absent" || inspection.Health != "absent" {
			return false
		}
	default:
		return false
	}
	return true
}
