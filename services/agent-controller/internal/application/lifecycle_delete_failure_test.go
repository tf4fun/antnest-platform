package application

import (
	"context"
	"slices"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestDeleteDefinitiveFailureIsRetainedWithoutReleasingResources(t *testing.T) {
	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.runtime = ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "docker_denied", ErrorDetail: "Docker rejected deletion"}
	service := NewLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(730, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	input := DeleteAgentInput{RequestID: "delete-definitive-failure", AgentID: base.Agent.AgentID}
	result, err := executeDeleteForTest(service, context.Background(), input)
	if err != nil || result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "docker_denied" || result.Operation.ErrorDetail != "Docker rejected deletion" {
		t.Fatalf("failure not retained: %+v %v", result, err)
	}
	if store.state.Agent.DesiredState != domain.DesiredDeleted || (store.state.Agent.LifecycleState != domain.AgentCreated || store.state.Agent.ActivationState != domain.ActivationEnabled || store.state.Agent.RuntimeState != domain.RuntimeUnknown) || store.state.Agent.ActiveOperationRequestID != "" {
		t.Fatalf("unsafe failure projection: %+v", store.state.Agent)
	}
	if slices.Contains(dependencies.calls, "egress.release") || store.published.RequestID != "" {
		t.Fatalf("failure crossed deletion barrier: %v", dependencies.calls)
	}
	calls := len(dependencies.calls)
	if _, err := executeDeleteForTest(service, context.Background(), input); err != nil || len(dependencies.calls) != calls {
		t.Fatalf("terminal replay repeated effects: %v %v", dependencies.calls, err)
	}
}

func TestDeleteDrainDeadlineEndsAttemptButKeepsDeletionIntent(t *testing.T) {
	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDeleteDependencies(base.Agent)
	service := NewLifecycleServiceWithDrainTimeout(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(900, 0).UTC()}, time.Minute,
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	input := DeleteAgentInput{RequestID: "delete-drain-timeout", AgentID: base.Agent.AgentID}
	if _, err := service.DeleteAgent(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	service.clock = fixedClock{now: time.Unix(961, 0).UTC()}
	result, err := executeDeleteForTest(service, context.Background(), input)
	if err != nil || result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "drain_timeout" || len(dependencies.calls) != 0 {
		t.Fatalf("drain failure: %+v %v calls=%v", result, err, dependencies.calls)
	}
}

func TestDeleteRetryResolvesFreshRuntimeWithoutRevivingAgent(t *testing.T) {
	base := deleteAgentBase(domain.RuntimeUnknown)
	base.Agent.DesiredState = domain.DesiredDeleted
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	service := NewLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(950, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	result, err := service.DeleteAgent(context.Background(), DeleteAgentInput{RequestID: "delete-explicit-retry", AgentID: base.Agent.AgentID})
	if err != nil || result.Operation.State != domain.OperationRunning || store.begin.Operation.SourceRuntimeRevision != "" {
		t.Fatalf("retry must resolve its Runtime source afresh: %+v %v", result, err)
	}
}
