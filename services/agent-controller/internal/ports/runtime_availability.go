package ports

import (
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type PendingRuntimeBinding struct {
	Agent                 AgentRecord
	Spec                  AgentSpecRecord
	Operation             LifecycleOperationRecord
	NextExecutionRevision int64
}

type PublishRuntimeBinding struct {
	ExpectedAggregateSequence int64
	OperationRequestID        string
	Execution                 ExecutionRecord
	BoundEvent                AgentEventRecord
}

func (agent AgentRecord) AwaitingRuntimeBinding() bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		!agent.LifecycleTerminated() &&
		agent.LifecycleState == domain.AgentCreated && agent.ActivationState == domain.ActivationEnabled &&
		agent.ExecutionRevisionID == "" && agent.FailureStage != "runtime_observation" && agent.ActiveOperationRequestID == "" &&
		agent.HasConfiguredRuntime()
}

// RuntimePreparing distinguishes an initial, authorized binding wait from a
// failed or inactive Runtime. It grants no execution authority.
func (agent AgentRecord) RuntimePreparing() bool {
	if !agent.AwaitingRuntimeBinding() || agent.OwnerUserID == "" {
		return false
	}
	return agent.RuntimeState == domain.RuntimeUnknown ||
		agent.RuntimeState == domain.RuntimeWaiting || agent.RuntimeState == domain.RuntimeAvailable
}

func (agent AgentRecord) CanObserveRuntime() bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		!agent.LifecycleTerminated() &&
		agent.ActiveOperationRequestID == "" && agent.HasConfiguredRuntime()
}
