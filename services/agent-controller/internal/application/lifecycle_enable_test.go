package application

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestEnableAgentPublishesNewExecutionAfterPolicyRestoration(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-1", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("enable Agent: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredEnabled ||
		result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Agent.ExecutionRevisionID == "" ||
		result.Agent.ExecutionRevisionID == base.LastSuccessfulExecution.ID {
		t.Fatalf("enabled Agent = %+v", result.Agent)
	}
	if result.Operation.State != domain.OperationCompleted {
		t.Fatalf("enable operation = %+v", result.Operation)
	}
	if store.published.Execution.Revision != base.NextExecutionRevision ||
		store.published.Execution.AgentSpecRevisionID != base.Spec.ID ||
		store.published.EnabledEvent.EventType != ports.EventAgentEnabled {
		t.Fatalf("enable publish = %+v", store.published)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.network.get", "egress.fence", "egress.policy.get",
		"runtime.enable", "egress.policy.get", "egress.policy.assign", "egress.ensure",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("enable calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestEnableAgentCompletedReplayHasNoDependencyEffects(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base, replayed: true}
	store.state = completedEnableState(base)
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: store.state.Operation.RequestID, AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("replay enable Agent: %v", err)
	}
	if result.Operation.State != domain.OperationCompleted || len(dependencies.calls) != 0 {
		t.Fatalf("replayed enable = %+v calls=%v", result, dependencies.calls)
	}
}

func TestEnableAgentReplaysRunningRuntimeWithSameChildRequest(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{
		State: "running", Effect: "unknown",
		RuntimeRevision: "rtv_55555555555555555555555555555555",
	})
	service := newLifecycleTestService(t, store, dependencies)
	input := EnableAgentInput{
		RequestID: "request-enable-running", AgentID: base.Agent.AgentID,
	}

	first, err := service.EnableAgent(context.Background(), input)
	if err != nil {
		t.Fatalf("start running enable: %v", err)
	}
	if first.Operation.State != domain.OperationRunning ||
		first.Operation.Phase != domain.PhaseRuntimeEnable {
		t.Fatalf("running enable = %+v", first)
	}
	store.replayed = true
	dependencies.runtime = readyEnableRuntime()
	second, err := service.EnableAgent(context.Background(), input)
	if err != nil {
		t.Fatalf("replay running enable: %v", err)
	}
	if second.Operation.State != domain.OperationCompleted ||
		len(dependencies.runtimeRequestIDs) != 2 ||
		dependencies.runtimeRequestIDs[0] != dependencies.runtimeRequestIDs[1] {
		t.Fatalf("replayed enable = %+v Runtime requests=%v", second, dependencies.runtimeRequestIDs)
	}
}

func TestEnableAgentKnownRuntimeFailurePreservesDisabledProjection(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", RuntimeRevision: base.Agent.RuntimeRevision,
		ErrorCode: "runtime_enable_rejected", ErrorDetail: "image unavailable",
	})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-failed", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("known failed enable: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredDisabled ||
		result.Agent.LifecycleState != domain.AgentDisabled ||
		result.Operation.State != domain.OperationFailed {
		t.Fatalf("failed enable = %+v failure=%+v", result, store.failed)
	}
	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{
			"egress.policy.get", "egress.network.get", "egress.fence",
			"egress.policy.get", "runtime.enable", "runtime.inspect",
		},
	) {
		t.Fatalf("failed enable calls = %v", dependencies.calls)
	}
}

func TestEnableAgentRuntimeMismatchRemainsReplayableAndFenced(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", RuntimeRevision: base.Agent.RuntimeRevision,
		ErrorCode: "runtime_enable_rejected", ErrorDetail: "revision changed",
	})
	dependencies.inspection = ports.RuntimeInspection{
		AgentID:            base.Agent.AgentID,
		RuntimeRevision:    "rtv_66666666666666666666666666666666",
		RuntimeExecutionID: "unexpected-live-runtime",
		MCPEndpoint:        "http://unexpected-runtime:8080/mcp",
		LifecycleState:     "ready", Health: "healthy",
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-mismatch", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("Runtime mismatch error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeEnable || store.failed.Code != "" {
		t.Fatalf("Runtime mismatch result = %+v failure=%+v", result, store.failed)
	}
	if dependencies.calls[len(dependencies.calls)-1] != "egress.fence" {
		t.Fatalf("Runtime mismatch did not fence network: %v", dependencies.calls)
	}
}

func TestEnableAgentPolicyConflictAfterRuntimeReadyRemainsReplayable(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	dependencies.policyResults = []ports.NetworkPolicyAssignment{
		dependencies.currentPolicy,
		dependencies.currentPolicy,
		{
			AgentID: base.Agent.AgentID, PolicyID: "unrelated-policy",
			Revision: 3, ResourceVersion: 12,
		},
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-conflict", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("policy conflict error = %v", err)
	}
	if !strings.Contains(err.Error(), "policy_restore_conflict") {
		t.Fatalf("policy conflict lost diagnostic code: %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkRestore || store.published.Execution.ID != "" {
		t.Fatalf("policy conflict result = %+v publish=%+v", result, store.published)
	}
	if dependencies.calls[len(dependencies.calls)-1] != "egress.fence" {
		t.Fatalf("policy conflict did not fence network: %v", dependencies.calls)
	}
}

func TestEnableAgentRejectsUnrelatedPolicyBeforeRuntimeStartup(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	dependencies.currentPolicy = ports.NetworkPolicyAssignment{
		AgentID: base.Agent.AgentID, PolicyID: "unrelated-policy",
		Revision: 3, ResourceVersion: 12,
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-preflight-conflict", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("preflight policy conflict: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredDisabled ||
		result.Operation.State != domain.OperationFailed ||
		store.failed.Code != "policy_restore_conflict" {
		t.Fatalf("preflight conflict result = %+v failure=%+v", result, store.failed)
	}
	if !reflect.DeepEqual(dependencies.calls, []string{"egress.policy.get"}) {
		t.Fatalf("preflight conflict calls = %v", dependencies.calls)
	}
}

func TestEnableAgentRejectsDisabledProjectionWithoutCapturedPolicy(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	base.NetworkPolicyAssignment = ports.NetworkPolicyAssignment{}
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	_, err := service.EnableAgent(context.Background(), EnableAgentInput{
		RequestID: "request-enable-without-policy", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrAgentNotReady) {
		t.Fatalf("missing captured policy error = %v", err)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("missing captured policy made dependency calls: %v", dependencies.calls)
	}
}

func enableLifecycleBase(t *testing.T) ports.AgentEnableBase {
	t.Helper()
	disabled := disableLifecycleBase(t)
	agent := disabled.Agent
	agent.DesiredState = domain.DesiredDisabled
	agent.LifecycleState = domain.AgentDisabled
	agent.ExecutionRevisionID = ""
	agent.LastSuccessfulExecutionRevisionID = disabled.ExecutableExecution.ID
	agent.RuntimeRevision = "rtv_44444444444444444444444444444444"
	agent.RuntimeExecutionID = ""
	agent.RuntimeMCPEndpoint = ""
	return ports.AgentEnableBase{
		Agent: agent, Spec: disabled.ExecutableSpec,
		LastSuccessfulExecution: disabled.ExecutableExecution,
		NetworkPolicyAssignment: ports.NetworkPolicyAssignment{
			AgentID: agent.AgentID, PolicyID: "internet-enabled", Revision: 1, ResourceVersion: 7,
		},
		NextExecutionRevision: disabled.ExecutableExecution.Revision + 1,
	}
}

func readyEnableRuntime() ports.RuntimeOperation {
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_55555555555555555555555555555555",
		RuntimeExecutionID: "runtime-execution-enabled",
		MCPEndpoint:        "http://runtime-enabled:8080/mcp",
		LifecycleState:     "ready", Health: "healthy",
	}
}

type enableDependenciesStub struct {
	calls                   []string
	network                 ports.NetworkAttachment
	currentPolicy           ports.NetworkPolicyAssignment
	policyResults           []ports.NetworkPolicyAssignment
	policyIndex             int
	runtime                 ports.RuntimeOperation
	inspection              ports.RuntimeInspection
	runtimeConfiguration    ports.RuntimeConfiguration
	expectedRuntimeRevision string
	runtimeRequestIDs       []string
}

func newEnableDependencies(
	base ports.AgentEnableBase, runtime ports.RuntimeOperation,
) *enableDependenciesStub {
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	return &enableDependenciesStub{
		network: network,
		currentPolicy: ports.NetworkPolicyAssignment{
			AgentID: base.Agent.AgentID, PolicyID: ports.BuiltinDenyAllPolicyID, Revision: 1,
			ResourceVersion: base.NetworkPolicyAssignment.ResourceVersion + 1,
		},
		runtime: runtime,
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "disabled", Health: "absent",
		},
	}
}

func (dependency *enableDependenciesStub) GetAgentNetwork(
	context.Context, string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.network.get")
	return dependency.network, nil
}

func (dependency *enableDependenciesStub) EnsureAgentNetwork(
	context.Context, string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	return dependency.network, nil
}

func (dependency *enableDependenciesStub) GetAgentPolicyAssignment(
	context.Context, string,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.get")
	result := dependency.currentPolicy
	if dependency.policyIndex < len(dependency.policyResults) {
		result = dependency.policyResults[dependency.policyIndex]
	}
	dependency.policyIndex++
	return result, nil
}

func (dependency *enableDependenciesStub) AssignAgentPolicy(
	_ context.Context, assignment ports.NetworkPolicyAssignment, expected uint64,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.assign")
	assignment.ResourceVersion = expected + 1
	return assignment, nil
}

func (dependency *enableDependenciesStub) FenceAgentNetwork(context.Context, string, uint64) error {
	dependency.calls = append(dependency.calls, "egress.fence")
	return nil
}

func (dependency *enableDependenciesStub) ResetAgentFlows(context.Context, string, uint64) error {
	return errors.New("unexpected Egress flow reset")
}

func (dependency *enableDependenciesStub) ReleaseAgentNetwork(
	context.Context, string, uint64,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network release")
}

func (dependency *enableDependenciesStub) InitializeRuntime(
	context.Context, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime initialize")
}

func (dependency *enableDependenciesStub) UpdateRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime update")
}

func (dependency *enableDependenciesStub) DisableRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime disable")
}

func (dependency *enableDependenciesStub) EnableRuntime(
	_ context.Context, requestID string, _ string, expected string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.enable")
	dependency.runtimeRequestIDs = append(dependency.runtimeRequestIDs, requestID)
	dependency.expectedRuntimeRevision = expected
	dependency.runtimeConfiguration = configuration
	return dependency.runtime, nil
}

func (dependency *enableDependenciesStub) DeleteRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime delete")
}

func (dependency *enableDependenciesStub) InspectRuntime(
	context.Context, string,
) (ports.RuntimeInspection, error) {
	dependency.calls = append(dependency.calls, "runtime.inspect")
	return dependency.inspection, nil
}

type enableLifecycleStoreStub struct {
	lifecycleStoreStub
	base      ports.AgentEnableBase
	state     ports.AgentEnableState
	replayed  bool
	published ports.PublishAgentEnable
	failed    ports.FailAgentEnable
}

func (store *enableLifecycleStoreStub) GetAgentEnableBase(
	context.Context, string,
) (ports.AgentEnableBase, error) {
	return store.base, nil
}

func (store *enableLifecycleStoreStub) ReplayAgentEnable(
	context.Context, string, string,
) (ports.AgentEnableState, bool, error) {
	return store.state, store.replayed, nil
}

func (store *enableLifecycleStoreStub) BeginAgentEnable(
	_ context.Context, input ports.BeginAgentEnable,
) (ports.AgentEnableState, bool, error) {
	if store.replayed {
		return store.state, true, nil
	}
	agent := store.base.Agent
	agent.DesiredState = domain.DesiredEnabled
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	operation := input.Operation
	policy := store.base.NetworkPolicyAssignment
	operation.NetworkPolicyAssignment = &policy
	store.state = ports.AgentEnableState{
		Agent: agent, Spec: store.base.Spec,
		LastSuccessfulExecution: store.base.LastSuccessfulExecution,
		Operation:               operation,
	}
	return store.state, false, nil
}

func (store *enableLifecycleStoreStub) AdvanceAgentEnable(
	_ context.Context, input ports.AdvanceAgentEnable,
) (ports.AgentEnableState, error) {
	store.state.Operation.Phase = input.NextPhase
	store.state.Operation.ChildRequestID = input.NextChildRequestID
	store.state.Operation.UpdatedAt = input.Now
	if input.NetworkAttachment != nil {
		attachment := *input.NetworkAttachment
		store.state.Operation.NetworkAttachment = &attachment
	}
	if input.RuntimeResult != nil {
		runtime := *input.RuntimeResult
		store.state.Operation.RuntimeResult = &runtime
	}
	return store.state, nil
}

func (store *enableLifecycleStoreStub) PublishAgentEnable(
	_ context.Context, input ports.PublishAgentEnable,
) (ports.AgentEnableState, error) {
	store.published = input
	store.state.Agent.DesiredState = domain.DesiredEnabled
	store.state.Agent.LifecycleState = domain.AgentAvailable
	store.state.Agent.AgentSpecRevisionID = input.Execution.AgentSpecRevisionID
	store.state.Agent.ExecutionRevisionID = input.Execution.ID
	store.state.Agent.LastSuccessfulExecutionRevisionID = input.Execution.ID
	store.state.Agent.RuntimeRevision = input.Execution.RuntimeRevision
	store.state.Agent.RuntimeExecutionID = input.Execution.RuntimeExecutionID
	store.state.Agent.RuntimeMCPEndpoint = input.Execution.RuntimeMCPEndpoint
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.AggregateSequence = input.EnabledEvent.AggregateSequence
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
	store.state.Operation.RecoveryOwner = ""
	store.state.Operation.RecoveryLeaseUntil = nil
	store.state.Operation.ChildRequestID = ""
	return store.state, nil
}

func (store *enableLifecycleStoreStub) FailAgentEnable(
	_ context.Context, input ports.FailAgentEnable,
) (ports.AgentEnableState, error) {
	store.failed = input
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.AggregateSequence = input.FailedEvent.AggregateSequence
	store.state.Agent.FailureStage = string(input.Stage)
	store.state.Agent.FailureCode = input.Code
	store.state.Agent.DesiredState = domain.DesiredDisabled
	store.state.Agent.LifecycleState = domain.AgentDisabled
	store.state.Operation.State = domain.OperationFailed
	store.state.Operation.RecoveryOwner = ""
	store.state.Operation.RecoveryLeaseUntil = nil
	store.state.Operation.ErrorCode = input.Code
	store.state.Operation.ErrorDetail = input.Detail
	store.state.Operation.SourceRuntimeInspection = input.SourceRuntimeInspection
	return store.state, nil
}

func completedEnableState(base ports.AgentEnableBase) ports.AgentEnableState {
	state := ports.AgentEnableState{
		Agent: base.Agent, Spec: base.Spec,
		LastSuccessfulExecution: base.LastSuccessfulExecution,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-enable-replay", RequestFingerprint: "fingerprint",
			AgentID: base.Agent.AgentID, Kind: domain.OperationEnable,
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
		},
	}
	state.Agent.DesiredState = domain.DesiredEnabled
	state.Agent.LifecycleState = domain.AgentAvailable
	return state
}

var _ ports.LifecycleStore = (*enableLifecycleStoreStub)(nil)
var _ ports.EgressClient = (*enableDependenciesStub)(nil)
var _ ports.RuntimeClient = (*enableDependenciesStub)(nil)
