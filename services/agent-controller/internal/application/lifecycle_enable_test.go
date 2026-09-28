package application

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestEnableAgentCompletesBeforeNewExecution(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-1", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("enable Agent: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredEnabled ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		result.Agent.ExecutionRevisionID != "" ||
		result.Agent.LastSuccessfulExecutionRevisionID != base.LastSuccessfulExecution.ID {
		t.Fatalf("enabled Agent = %+v", result.Agent)
	}
	if result.Operation.State != domain.OperationCompleted {
		t.Fatalf("enable operation = %+v", result.Operation)
	}
	if store.state.Agent.AgentSpecRevisionID != base.Spec.ID ||
		store.published.EnabledEvent.EventType != ports.EventAgentEnabled {
		t.Fatalf("enable publish = %+v", store.published)
	}
	wantCalls := []string{
		"egress.ensure", "runtime.enable", "egress.attachment.open",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("enable calls = %v, want %v", dependencies.calls, wantCalls)
	}
	if len(base.Spec.Snapshot.Runtime.MCPServers) == 0 || !reflect.DeepEqual(dependencies.runtimeConfiguration.MCPServers, base.Spec.Snapshot.Runtime.MCPServers) {
		t.Fatal("enable did not restore saved MCP configuration")
	}
}

func TestEnableAgentCompletedReplayHasNoDependencyEffects(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base, replayed: true}
	store.state = completedEnableState(base)
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
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

	first, err := executeEnableForTest(service, context.Background(), input)
	if err != nil {
		t.Fatalf("start running enable: %v", err)
	}
	if first.Operation.State != domain.OperationRunning ||
		first.Operation.Phase != domain.PhaseRuntimeEnable {
		t.Fatalf("running enable = %+v", first)
	}
	store.replayed = true
	dependencies.runtime = readyEnableRuntime()
	second, err := executeEnableForTest(service, context.Background(), input)
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

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-failed", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("known failed enable: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredDisabled ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationDisabled || result.Agent.RuntimeState != domain.RuntimeAbsent) ||
		result.Operation.State != domain.OperationFailed {
		t.Fatalf("failed enable = %+v failure=%+v", result, store.failed)
	}
	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{"egress.ensure", "runtime.enable", "runtime.inspect"},
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
		LifecycleState:     "provisioned", Health: "healthy",
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-mismatch", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("Runtime mismatch error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeEnable || store.failed.Code != "" {
		t.Fatalf("Runtime mismatch result = %+v failure=%+v", result, store.failed)
	}
	if dependencies.calls[len(dependencies.calls)-1] != "egress.network.get" {
		t.Fatalf("Runtime mismatch did not confirm the closed attachment: %v", dependencies.calls)
	}
}

func TestEnableAgentInspectionFailureRemainsReplayableAndFenced(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", RuntimeRevision: base.Agent.RuntimeRevision,
		ErrorCode: "runtime_enable_rejected", ErrorDetail: "revision changed",
	})
	dependencies.inspectionErr = &ports.DependencyError{
		Service: "runtime-controller", Code: "runtime_inspection_failed", Retryable: true,
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-inspection-failed", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("Runtime inspection error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeEnable || store.failed.Code != "" {
		t.Fatalf("Runtime inspection result = %+v failure=%+v", result, store.failed)
	}
	if dependencies.calls[len(dependencies.calls)-1] != "egress.network.get" {
		t.Fatalf("Runtime inspection failure did not confirm the closed attachment: %v", dependencies.calls)
	}
}

func TestEnableAgentAttachmentOpenFailureAfterRuntimeReadyRemainsReplayable(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	dependencies.attachmentOpenErr = &ports.DependencyError{
		Service: "runtime-egress", Code: "resource_version_conflict", Retryable: true,
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-conflict", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("attachment open error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkRestore || store.published.RequestID != "" {
		t.Fatalf("attachment conflict result = %+v publish=%+v", result, store.published)
	}
	if dependencies.calls[len(dependencies.calls)-1] != "egress.attachment.open" {
		t.Fatalf("ambiguous open must not change the retry version: %v", dependencies.calls)
	}
}

func TestEnableAgentRejectsIncompleteAttachmentBeforeRuntimeStartup(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	dependencies.network.NetworkResourceVersion = 0
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-invalid-network", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("invalid preflight attachment: %v", err)
	}
	if result.Agent.DesiredState != domain.DesiredDisabled ||
		result.Operation.State != domain.OperationFailed ||
		store.failed.Code != "invalid_network_attachment" ||
		store.failed.SourceRuntimeInspection == nil {
		t.Fatalf("invalid preflight result = %+v failure=%+v", result, store.failed)
	}
	if !reflect.DeepEqual(dependencies.calls, []string{"egress.ensure", "runtime.inspect"}) {
		t.Fatalf("invalid preflight calls = %v", dependencies.calls)
	}
}

func TestEnableAgentKeepsRunningWhenPreflightFailureCannotProveDisabledRuntime(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	dependencies.network.NetworkResourceVersion = 0
	dependencies.inspection.RuntimeRevision = "rtv_99999999999999999999999999999999"
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-preflight-runtime-drift", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("preflight Runtime drift error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkEnsure || store.failed.Code != "" {
		t.Fatalf("preflight Runtime drift result = %+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.ensure", "runtime.inspect", "egress.network.get", "egress.attachment.closed",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("preflight Runtime drift calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestEnableAgentRejectsIncompleteDisabledProjection(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	base.Agent.RuntimeRevision = ""
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, readyEnableRuntime())
	service := newLifecycleTestService(t, store, dependencies)

	_, err := executeEnableForTest(service, context.Background(), EnableAgentInput{
		RequestID: "request-enable-incomplete", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrAgentNotReady) {
		t.Fatalf("incomplete disabled projection error = %v", err)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("incomplete disabled projection made dependency calls: %v", dependencies.calls)
	}
}

func enableLifecycleBase(t *testing.T) ports.AgentEnableBase {
	t.Helper()
	disabled := disableLifecycleBase(t)
	agent := disabled.Agent
	agent.DesiredState = domain.DesiredDisabled
	agent.LifecycleState, agent.ActivationState, agent.RuntimeState = domain.AgentCreated, domain.ActivationDisabled, domain.RuntimeAbsent
	agent.ExecutionRevisionID = ""
	agent.LastSuccessfulExecutionRevisionID = disabled.SourceExecution.ID
	agent.RuntimeRevision = "rtv_44444444444444444444444444444444"
	agent.RuntimeExecutionID = ""
	agent.RuntimeMCPEndpoint = ""
	return ports.AgentEnableBase{
		Agent: agent, Spec: disabled.ConfiguredSpec,
		LastSuccessfulExecution: disabled.SourceExecution,
		NextSpecRevision:        disabled.ConfiguredSpec.Revision + 1,
		NextExecutionRevision:   disabled.SourceExecution.Revision + 1,
	}
}

func readyEnableRuntime() ports.RuntimeOperation {
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_55555555555555555555555555555555",
		RuntimeExecutionID: "",
		MCPEndpoint:        "",
		LifecycleState:     "provisioned", Health: "unknown",
	}
}

type enableDependenciesStub struct {
	calls                   []string
	network                 ports.NetworkAttachment
	attachmentOpenErr       error
	attachmentClosed        bool
	runtime                 ports.RuntimeOperation
	inspection              ports.RuntimeInspection
	inspectionErr           error
	runtimeConfiguration    ports.RuntimeConfiguration
	expectedRuntimeRevision string
	runtimeRequestIDs       []string
	runtimeAgentID          string
}

func newEnableDependencies(
	base ports.AgentEnableBase, runtime ports.RuntimeOperation,
) *enableDependenciesStub {
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	return &enableDependenciesStub{
		network: network, attachmentClosed: true, runtime: runtime,
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "disabled", Health: "absent",
		},
	}
}

func (dependency *enableDependenciesStub) GetAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.network.get")
	result := dependency.network
	result.AgentID = agentID
	if dependency.attachmentClosed {
		result.AttachmentState = ports.NetworkAttachmentClosed
	} else {
		result.AttachmentState = ports.NetworkAttachmentOpen
	}
	return result, nil
}

func (dependency *enableDependenciesStub) EnsureAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	result := dependency.network
	result.AgentID = agentID
	result.AttachmentState = ports.NetworkAttachmentClosed
	dependency.network = result
	dependency.attachmentClosed = true
	return result, nil
}

func (dependency *enableDependenciesStub) SetAgentNetworkAttachment(
	_ context.Context, agentID string, state string, expectedResourceVersion uint64,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.attachment."+state)
	if state == ports.NetworkAttachmentOpen && dependency.attachmentOpenErr != nil {
		return ports.NetworkAttachment{}, dependency.attachmentOpenErr
	}
	result := dependency.network
	result.AgentID = agentID
	result.State = ports.NetworkStateActive
	result.AttachmentState = state
	result.AttachmentResourceVersion = expectedResourceVersion + 1
	dependency.network = result
	dependency.attachmentClosed = state == ports.NetworkAttachmentClosed
	return result, nil
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
	_ context.Context, requestID string, agentID string, expected string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.enable")
	dependency.runtimeRequestIDs = append(dependency.runtimeRequestIDs, requestID)
	dependency.runtimeAgentID = agentID
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
	return dependency.inspection, dependency.inspectionErr
}

type enableLifecycleStoreStub struct {
	lifecycleStoreStub
	base      ports.AgentEnableBase
	state     ports.AgentEnableState
	replayed  bool
	published ports.PublishAgentEnable
	begin     ports.BeginAgentEnable
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
	store.begin = input
	if store.replayed {
		return store.state, true, nil
	}
	agent := store.base.Agent
	agent.DesiredState = domain.DesiredEnabled
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	operation := input.Operation
	target := store.base.Spec
	if input.TargetSpec != nil {
		target = *input.TargetSpec
	}
	store.state = ports.AgentEnableState{
		Agent: agent, Spec: target, SourceSpec: store.base.Spec,
		LastSuccessfulExecution: store.base.LastSuccessfulExecution,
		Operation:               operation, LegacyMigration: input.LegacyMigration,
	}
	store.replayed = true
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
	store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	store.state.Agent.AgentSpecRevisionID = store.state.Spec.ID
	store.state.Agent.ExecutionRevisionID = ""
	store.state.Agent.RuntimeRevision = store.state.Operation.RuntimeResult.RuntimeRevision
	store.state.Agent.RuntimeExecutionID = ""
	store.state.Agent.RuntimeMCPEndpoint = ""
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.AggregateSequence = input.EnabledEvent.AggregateSequence
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
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
	store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationDisabled, domain.RuntimeAbsent
	store.state.Operation.State = domain.OperationFailed
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
	state.Agent.LifecycleState, state.Agent.ActivationState, state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeAvailable
	return state
}

var _ ports.LifecycleStore = (*enableLifecycleStoreStub)(nil)
var _ ports.EgressClient = (*enableDependenciesStub)(nil)
var _ ports.RuntimeClient = (*enableDependenciesStub)(nil)

func (store *enableLifecycleStoreStub) GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error) {
	return store.state.Operation, nil
}
