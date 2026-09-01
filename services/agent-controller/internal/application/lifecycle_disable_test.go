package application

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestDisableAgentFencesRuntimeAndPublishesDisabledProjection(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_33333333333333333333333333333333",
		LifecycleState:  "disabled", Health: "absent",
	})
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(200, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-agent", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent: %v", err)
	}

	wantCalls := []string{"egress.policy.get", "egress.fence", "runtime.disable"}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if dependencies.expectedRuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("expected Runtime revision = %q", dependencies.expectedRuntimeRevision)
	}
	if store.begin.RequestedEvent.EventType != ports.EventAgentDisableRequested ||
		store.published.DisabledEvent.EventType != ports.EventAgentDisabled {
		t.Fatalf("disable events: begin=%+v publish=%+v", store.begin, store.published)
	}
	if store.runReleaseEvent.EventType != ports.EventRunAdmissionReleased ||
		store.runReleaseEvent.Data["release_reason"] != "runtime_disabled" ||
		store.runReleaseEvent.Data["source_runtime_revision"] != base.Agent.RuntimeRevision {
		t.Fatalf("disable Run release event = %+v", store.runReleaseEvent)
	}
	if result.Operation.State != domain.OperationCompleted ||
		result.Agent.DesiredState != domain.DesiredDisabled ||
		result.Agent.LifecycleState != domain.AgentDisabled ||
		result.Agent.AgentSpecRevisionID != base.Agent.AgentSpecRevisionID ||
		result.Agent.ExecutionRevisionID != "" ||
		result.Agent.LastSuccessfulExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		result.Agent.RuntimeRevision != dependencies.runtime.RuntimeRevision ||
		result.Agent.RuntimeExecutionID != "" || result.Agent.RuntimeMCPEndpoint != "" {
		t.Fatalf("disabled result = %+v", result)
	}
}

func TestDisableAgentWaitsForActiveRunWithoutExternalEffects(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{})
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(210, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-drain", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent while draining: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain ||
		result.Operation.State != domain.OperationRunning ||
		result.Agent.DesiredState != domain.DesiredDisabled {
		t.Fatalf("draining disable = %+v", result)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("draining disable called dependencies: %v", dependencies.calls)
	}
}

func TestDisableAgentKnownRuntimeFailureRestoresPolicyAndExecutable(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", ErrorCode: "platform_unavailable",
	})
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(220, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-failed", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent with conclusive Runtime failure: %v", err)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.fence", "runtime.disable", "runtime.inspect",
		"egress.policy.get", "egress.policy.assign", "egress.ensure",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if result.Operation.State != domain.OperationFailed ||
		result.Operation.ErrorCode != "platform_unavailable" ||
		result.Agent.DesiredState != domain.DesiredEnabled ||
		result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		result.Agent.RuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("failed disable result = %+v", result)
	}
}

func TestDisableAgentDoesNotRestoreUnverifiedRuntime(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", ErrorCode: "platform_unavailable",
	})
	dependencies.inspection.RuntimeExecutionID = "different-execution"
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(225, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-unverified", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent with changed Runtime: %v", err)
	}
	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{"egress.policy.get", "egress.fence", "runtime.disable", "runtime.inspect"},
	) {
		t.Fatalf("unverified disable calls = %v", dependencies.calls)
	}
	if store.failed.PreserveExecutable || result.Operation.State != domain.OperationFailed ||
		result.Agent.DesiredState != domain.DesiredDisabled ||
		result.Agent.LifecycleState != domain.AgentUnavailable ||
		result.Agent.AgentSpecRevisionID != "" || result.Agent.ExecutionRevisionID != "" ||
		result.Agent.RuntimeRevision != "" {
		t.Fatalf("unverified disable result = %+v, failure = %+v", result, store.failed)
	}
}

func TestDisableAgentRuntimeNotFoundRemainsRunningAndFenced(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	missing := &ports.DependencyError{
		Service: "runtime-controller", Code: "runtime_not_found", Retryable: false,
	}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{})
	dependencies.runtimeErr = missing
	dependencies.inspectionErr = missing
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(227, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-runtime-missing", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("disable Agent runtime_not_found error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeDisable ||
		result.Agent.ActiveOperationRequestID == "" || store.failed.RequestID != "" {
		t.Fatalf("runtime_not_found disable result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.fence", "runtime.disable", "runtime.inspect",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("Runtime-absence disable calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestDisableAgentDeletedRuntimeInspectionFailsClosedAndReleasesBlockedRun(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", ErrorCode: "runtime_lifecycle_conflict",
	})
	dependencies.inspection = ports.RuntimeInspection{
		AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		LifecycleState: "deleted", Health: "absent",
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(228, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-runtime-deleted", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent after deleted Runtime inspection: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		result.Agent.LifecycleState != domain.AgentUnavailable ||
		store.failed.RuntimeAbsenceProof == nil ||
		store.failed.RuntimeAbsenceProof.Reason != "runtime_deleted" ||
		store.failed.SourceRuntimeInspection != nil ||
		store.failed.RunReleaseEvent.Data["release_reason"] != "runtime_deleted" {
		t.Fatalf("deleted-Runtime disable result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.fence", "runtime.disable", "runtime.inspect",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("deleted-Runtime disable calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestDisableAgentAmbiguousRuntimeRemainsRunningAndFenced(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "unknown", Effect: "unknown",
		RuntimeRevision: "rtv_33333333333333333333333333333333",
	})
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(230, 0).UTC()},
	)

	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-disable-unknown", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent with ambiguous Runtime result: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeDisable ||
		result.Operation.State != domain.OperationRunning ||
		result.Agent.DesiredState != domain.DesiredDisabled || store.failed.RequestID != "" {
		t.Fatalf("ambiguous disable result = %+v failed=%+v", result, store.failed)
	}
	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{"egress.policy.get", "egress.fence", "runtime.disable"},
	) {
		t.Fatalf("ambiguous disable calls = %v", dependencies.calls)
	}
}

func disableLifecycleBase(t *testing.T) ports.AgentLifecycleBase {
	t.Helper()
	return rebuildLifecycleBase(t, mustLifecycleTemplate(t), mustLifecycleModel(t))
}

type disableDependenciesStub struct {
	calls                   []string
	policy                  ports.NetworkPolicyAssignment
	currentPolicy           ports.NetworkPolicyAssignment
	network                 ports.NetworkAttachment
	runtime                 ports.RuntimeOperation
	runtimeErr              error
	inspection              ports.RuntimeInspection
	inspectionErr           error
	expectedRuntimeRevision string
}

func newDisableDependencies(
	base ports.AgentLifecycleBase, runtime ports.RuntimeOperation,
) *disableDependenciesStub {
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	return &disableDependenciesStub{
		policy: ports.NetworkPolicyAssignment{
			AgentID: base.Agent.AgentID, PolicyID: "internet-enabled", Revision: 1, ResourceVersion: 7,
		},
		currentPolicy: ports.NetworkPolicyAssignment{
			AgentID: base.Agent.AgentID, PolicyID: ports.BuiltinDenyAllPolicyID,
			Revision: 1, ResourceVersion: 8,
		},
		network: network, runtime: runtime,
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			RuntimeExecutionID: base.ExecutableExecution.RuntimeExecutionID,
			MCPEndpoint:        base.ExecutableExecution.RuntimeMCPEndpoint,
			LifecycleState:     "ready", Health: "healthy",
		},
	}
}

func (dependency *disableDependenciesStub) EnsureAgentNetwork(
	_ context.Context, _ string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	return dependency.network, nil
}

func (dependency *disableDependenciesStub) GetAgentNetwork(
	context.Context, string,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network read")
}

func (dependency *disableDependenciesStub) GetAgentPolicyAssignment(
	_ context.Context, _ string,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.get")
	if len(dependency.calls) > 3 {
		return dependency.currentPolicy, nil
	}
	return dependency.policy, nil
}

func (dependency *disableDependenciesStub) AssignAgentPolicy(
	_ context.Context, assignment ports.NetworkPolicyAssignment, expected uint64,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.assign")
	assignment.ResourceVersion = expected + 1
	return assignment, nil
}

func (dependency *disableDependenciesStub) FenceAgentNetwork(context.Context, string, uint64) error {
	dependency.calls = append(dependency.calls, "egress.fence")
	return nil
}

func (dependency *disableDependenciesStub) ResetAgentFlows(context.Context, string, uint64) error {
	return errors.New("unexpected Egress flow reset")
}

func (dependency *disableDependenciesStub) ReleaseAgentNetwork(
	context.Context, string, uint64,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network release")
}

func (dependency *disableDependenciesStub) InitializeRuntime(
	context.Context, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime initialize")
}

func (dependency *disableDependenciesStub) UpdateRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime update")
}

func (dependency *disableDependenciesStub) DisableRuntime(
	_ context.Context, _ string, _ string, expectedRevision string,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.disable")
	dependency.expectedRuntimeRevision = expectedRevision
	return dependency.runtime, dependency.runtimeErr
}

func (dependency *disableDependenciesStub) EnableRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime enable")
}

func (dependency *disableDependenciesStub) DeleteRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime delete")
}

func (dependency *disableDependenciesStub) InspectRuntime(
	_ context.Context, _ string,
) (ports.RuntimeInspection, error) {
	dependency.calls = append(dependency.calls, "runtime.inspect")
	return dependency.inspection, dependency.inspectionErr
}

type disableLifecycleStoreStub struct {
	lifecycleStoreStub
	base            ports.AgentLifecycleBase
	begin           ports.BeginAgentDisable
	state           ports.AgentDisableState
	replayed        bool
	drainBlocked    bool
	published       ports.PublishAgentDisable
	failed          ports.FailAgentDisable
	runReleaseEvent ports.RunAdmissionEvent
}

func (store *disableLifecycleStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return store.base, nil
}

func (store *disableLifecycleStoreStub) ReplayAgentDisable(
	context.Context, string, string,
) (ports.AgentDisableState, bool, error) {
	return store.state, store.replayed, nil
}

func (store *disableLifecycleStoreStub) BeginAgentDisable(
	_ context.Context, input ports.BeginAgentDisable,
) (ports.AgentDisableState, bool, error) {
	store.begin = input
	if store.replayed {
		return store.state, true, nil
	}
	agent := store.base.Agent
	agent.DesiredState = domain.DesiredDisabled
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	store.state = ports.AgentDisableState{
		Agent: agent, SourceSpec: store.base.ExecutableSpec,
		SourceExecution: store.base.ExecutableExecution, Operation: input.Operation,
	}
	return store.state, false, nil
}

func (store *disableLifecycleStoreStub) RecordAgentDisablePolicy(
	_ context.Context, _ string, _ string,
	assignment ports.NetworkPolicyAssignment, now time.Time,
) (ports.AgentDisableState, error) {
	store.state.Operation.NetworkPolicyAssignment = &assignment
	store.state.Operation.UpdatedAt = now
	return store.state, nil
}

func (store *disableLifecycleStoreStub) SettleAgentDisableDrain(
	_ context.Context, _ string, _ string, nextChildRequestID string, now time.Time,
) (ports.AgentDisableState, error) {
	if store.drainBlocked {
		return store.state, nil
	}
	store.state.Operation.Phase = domain.PhaseNetworkFence
	store.state.Operation.ChildRequestID = nextChildRequestID
	store.state.Operation.UpdatedAt = now
	return store.state, nil
}

func (store *disableLifecycleStoreStub) AdvanceAgentDisable(
	_ context.Context, input ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	if input.RunReleaseEvent.EventID != "" {
		store.runReleaseEvent = input.RunReleaseEvent
	}
	store.state.Operation.Phase = input.NextPhase
	store.state.Operation.ChildRequestID = input.NextChildRequestID
	store.state.Operation.UpdatedAt = input.Now
	if input.RuntimeResult != nil {
		result := *input.RuntimeResult
		store.state.Operation.RuntimeResult = &result
	}
	return store.state, nil
}

func (store *disableLifecycleStoreStub) PublishAgentDisable(
	_ context.Context, input ports.PublishAgentDisable,
) (ports.AgentDisableState, error) {
	store.published = input
	store.state.Agent.DesiredState = domain.DesiredDisabled
	store.state.Agent.LifecycleState = domain.AgentDisabled
	store.state.Agent.ExecutionRevisionID = ""
	store.state.Agent.LastSuccessfulExecutionRevisionID = store.state.SourceExecution.ID
	store.state.Agent.RuntimeRevision = store.state.Operation.RuntimeResult.RuntimeRevision
	store.state.Agent.RuntimeExecutionID = ""
	store.state.Agent.RuntimeMCPEndpoint = ""
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.AggregateSequence = input.DisabledEvent.AggregateSequence
	store.state.Agent.UpdatedAt = input.Now
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
	store.state.Operation.ChildRequestID = ""
	store.state.Operation.UpdatedAt = input.Now
	return store.state, nil
}

func (store *disableLifecycleStoreStub) FailAgentDisable(
	_ context.Context, input ports.FailAgentDisable,
) (ports.AgentDisableState, error) {
	input.FailedEvent.AggregateSequence = input.ExpectedAggregateSequence + 1
	store.failed = input
	store.state.Operation.SourceRuntimeInspection = input.SourceRuntimeInspection
	store.state.Operation.SourceRuntimeAbsenceProof = input.RuntimeAbsenceProof
	if input.PreserveExecutable {
		store.state.Agent.DesiredState = domain.DesiredEnabled
		store.state.Agent.LifecycleState = domain.AgentAvailable
	} else {
		store.state.Agent.DesiredState = domain.DesiredDisabled
		store.state.Agent.LifecycleState = domain.AgentUnavailable
		store.state.Agent.AgentSpecRevisionID = ""
		store.state.Agent.ExecutionRevisionID = ""
		store.state.Agent.RuntimeRevision = ""
		store.state.Agent.RuntimeExecutionID = ""
		store.state.Agent.RuntimeMCPEndpoint = ""
	}
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.FailureStage = string(input.Stage)
	store.state.Agent.FailureCode = input.Code
	store.state.Agent.AggregateSequence = input.FailedEvent.AggregateSequence
	store.state.Agent.UpdatedAt = input.Now
	store.state.Operation.State = domain.OperationFailed
	store.state.Operation.ErrorCode = input.Code
	store.state.Operation.ErrorDetail = input.Detail
	store.state.Operation.UpdatedAt = input.Now
	return store.state, nil
}
