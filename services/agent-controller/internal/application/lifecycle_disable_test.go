package application

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(200, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
		RequestID: "request-disable-agent", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent: %v", err)
	}

	wantCalls := []string{"egress.get", "egress.attachment.closed", "runtime.disable"}
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
	if result.Operation.State != domain.OperationCompleted ||
		result.Agent.DesiredState != domain.DesiredDisabled ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationDisabled || result.Agent.RuntimeState != domain.RuntimeAbsent) ||
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(210, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
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

func TestDisableAgentExpiredDeadlineDoesNotQueryACPOrMutateRuntime(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	now := time.Unix(215, 0).UTC()
	state := ports.AgentDisableState{
		Agent: base.Agent, SourceSpec: base.ConfiguredSpec,
		SourceExecution: base.SourceExecution,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-disable-expired-drain", RequestFingerprint: "fingerprint",
			DrainDeadlineAt: testDrainDeadline(now.Add(-time.Minute)),
			AgentID:         base.Agent.AgentID, Kind: domain.OperationDisable,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			CreatedAt: now.Add(-2 * time.Minute), UpdatedAt: now.Add(-2 * time.Minute),
		},
	}
	store := &disableLifecycleStoreStub{base: base, state: state, replayed: true}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{})
	service := newTestLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: now}, time.Minute,
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	settled, err := service.settleDisableDrain(context.Background(), state)
	if err != nil {
		t.Fatalf("settle expired but empty disable drain: %v", err)
	}
	if settled.Operation.State != domain.OperationFailed || store.failed.Code != "run_drain_timeout" || len(dependencies.calls) != 0 {
		t.Fatalf("settled disable phase = %q failed=%+v", settled.Operation.Phase, store.failed)
	}
}

func TestDisableAgentKnownRuntimeFailureRestoresPolicyAndExecutable(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{
		State: "failed", Effect: "not_started", ErrorCode: "platform_unavailable",
	})
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(220, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
		RequestID: "request-disable-failed", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent with conclusive Runtime failure: %v", err)
	}
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.disable", "runtime.inspect",
		"egress.get", "runtime.inspect", "egress.attachment.open",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if result.Operation.State != domain.OperationFailed ||
		result.Operation.ErrorCode != "platform_unavailable" ||
		result.Agent.DesiredState != domain.DesiredEnabled ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeAvailable) ||
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(225, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
		RequestID: "request-disable-unverified", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent with changed Runtime: %v", err)
	}
	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{"egress.get", "egress.attachment.closed", "runtime.disable", "runtime.inspect"},
	) {
		t.Fatalf("unverified disable calls = %v", dependencies.calls)
	}
	if store.failed.PreserveExecutable || result.Operation.State != domain.OperationFailed ||
		result.Agent.DesiredState != domain.DesiredDisabled ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(227, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
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
		"egress.get", "egress.attachment.closed", "runtime.disable", "runtime.inspect",
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(228, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
		RequestID: "request-disable-runtime-deleted", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("disable Agent after deleted Runtime inspection: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		store.failed.RuntimeAbsenceProof == nil ||
		store.failed.RuntimeAbsenceProof.Reason != "runtime_deleted" ||
		store.failed.SourceRuntimeInspection != nil {
		t.Fatalf("deleted-Runtime disable result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.disable", "runtime.inspect",
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
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(230, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDisableForTest(service, context.Background(), DisableAgentInput{
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
		[]string{"egress.get", "egress.attachment.closed", "runtime.disable"},
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
	network                 ports.NetworkAttachment
	runtime                 ports.RuntimeOperation
	runtimeErr              error
	fenceErr                error
	inspection              ports.RuntimeInspection
	inspectionErr           error
	attachmentClosed        bool
	expectedRuntimeRevision string
	runtimeRequestID        string
	runtimeAgentID          string
}

func newDisableDependencies(
	base ports.AgentLifecycleBase, runtime ports.RuntimeOperation,
) *disableDependenciesStub {
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	return &disableDependenciesStub{
		network: network, runtime: runtime,
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			RuntimeExecutionID: base.SourceExecution.RuntimeExecutionID,
			MCPEndpoint:        base.SourceExecution.RuntimeMCPEndpoint,
			Phase:              "running", RuntimeEndpoint: "10.20.0.9", TunnelKeyID: "rtk_0123456789abcdef0123456789abcdef",
			LifecycleState: "provisioned", Health: "healthy",
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
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.get")
	result := dependency.network
	result.AgentID = agentID
	if dependency.attachmentClosed {
		result.AttachmentState = ports.NetworkAttachmentClosed
	} else {
		result.AttachmentState = ports.NetworkAttachmentOpen
	}
	return result, nil
}

func (dependency *disableDependenciesStub) SetAgentNetworkAttachment(
	_ context.Context, agentID string, state string, expectedResourceVersion uint64, runtimeEndpoint string, tunnelKeyID string) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.attachment."+state)
	if state == ports.NetworkAttachmentClosed && dependency.fenceErr != nil {
		return ports.NetworkAttachment{}, dependency.fenceErr
	}
	result := dependency.network
	result.AgentID = agentID
	result.State = ports.NetworkStateActive
	result.AttachmentState = state
	result.RuntimeEndpoint = runtimeEndpoint
	result.TunnelKeyID = tunnelKeyID
	result.AttachmentResourceVersion = expectedResourceVersion + 1
	dependency.network = result
	dependency.attachmentClosed = state == ports.NetworkAttachmentClosed
	return result, nil
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
	_ context.Context, requestID string, agentID string, expectedRevision string,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.disable")
	dependency.runtimeRequestID = requestID
	dependency.runtimeAgentID = agentID
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
	base         ports.AgentLifecycleBase
	begin        ports.BeginAgentDisable
	state        ports.AgentDisableState
	replayed     bool
	drainBlocked bool
	published    ports.PublishAgentDisable
	failed       ports.FailAgentDisable
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
		Agent: agent, SourceSpec: store.base.ConfiguredSpec,
		SourceExecution: store.base.SourceExecution, Operation: input.Operation,
	}
	store.replayed = true
	return store.state, false, nil
}

func (store *disableLifecycleStoreStub) AdvanceAgentDisable(
	_ context.Context, input ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	store.state.Operation.Phase = input.NextPhase
	store.state.Operation.ChildRequestID = input.NextChildRequestID
	store.state.Operation.UpdatedAt = input.Now
	if input.NetworkAttachment != nil {
		attachment := *input.NetworkAttachment
		store.state.Operation.NetworkAttachment = &attachment
	}
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
	store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationDisabled, domain.RuntimeAbsent
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
		store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeAvailable
	} else {
		store.state.Agent.DesiredState = domain.DesiredDisabled
		store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
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

func (store *disableLifecycleStoreStub) GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error) {
	return store.state.Operation, nil
}
