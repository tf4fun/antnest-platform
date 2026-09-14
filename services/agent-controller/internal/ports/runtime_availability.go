package ports

import (
	"soft/antnest-platform/services/agent-controller/internal/domain"
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
	ReadyEvent                AgentEventRecord
}

func (agent AgentRecord) AwaitingRuntimeBinding() bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		agent.LifecycleState == domain.AgentCreated && agent.ActivationState == domain.ActivationEnabled &&
		agent.ExecutionRevisionID == "" && agent.FailureStage != "runtime_observation" && agent.ActiveOperationRequestID == "" &&
		agent.HasConfiguredRuntime()
}

func (agent AgentRecord) CanObserveRuntime() bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		agent.ActiveOperationRequestID == "" && agent.HasConfiguredRuntime()
}
