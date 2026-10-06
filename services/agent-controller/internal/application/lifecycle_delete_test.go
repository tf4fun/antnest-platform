package application

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestDeleteAgentFencesDeletesReleasesThenPublishes(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(700, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-agent", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("delete Agent: %v", err)
	}
	wantCalls := []string{
		"egress.network.get", "egress.attachment.closed", "runtime.delete",
		"egress.network.get", "egress.release",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if dependencies.expectedRuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("Runtime revision fence = %q", dependencies.expectedRuntimeRevision)
	}
	if result.Agent.DesiredState != domain.DesiredDeleted ||
		result.Agent.LifecycleState != domain.AgentDeleted ||
		result.Agent.RuntimeRevision != "" || result.Agent.ExecutionRevisionID != "" ||
		result.Agent.LastSuccessfulExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		result.Agent.ActiveOperationRequestID != "" ||
		result.Operation.State != domain.OperationCompleted {
		t.Fatalf("deleted Agent result = %+v", result)
	}
	if store.published.DeletedEvent.EventType != ports.EventAgentDeleted {
		t.Fatalf("deleted event = %+v", store.published.DeletedEvent)
	}
}

func TestDeleteNetworkReleaseTreatsQuarantineAsLostResponseReplay(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	operation := ports.LifecycleOperationRecord{
		RequestID: "request-delete-release-replay", RequestFingerprint: "fingerprint",
		AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
		Phase: domain.PhaseNetworkRelease, State: domain.OperationRunning,
	}
	state := ports.AgentDeleteState{Agent: base.Agent, Operation: operation}
	store := &deleteLifecycleStoreStub{base: base, state: state, replayed: true}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.attachment.State = ports.NetworkStateQuarantined
	dependencies.attachment.AttachmentState = ports.NetworkAttachmentClosed
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(705, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	advanced, err := service.releaseDeleteNetwork(context.Background(), state)
	if err != nil {
		t.Fatalf("reconcile quarantined release: %v", err)
	}
	if !reflect.DeepEqual(dependencies.calls, []string{"egress.network.get"}) {
		t.Fatalf("release replay repeated side effects: %v", dependencies.calls)
	}
	if advanced.Operation.Phase != domain.PhasePublish ||
		advanced.Operation.NetworkReleaseOutcome != ports.NetworkReleaseQuarantined {
		t.Fatalf("release replay state = %+v", advanced.Operation)
	}
}

func TestDeleteAgentWithAuthoritativelyAbsentRuntimeSkipsRuntimeDelete(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeUnknown)
	base.Agent.RuntimeRevision = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	missingRuntime := &ports.DependencyError{
		Service: "runtime-controller", Code: "runtime_not_found", Retryable: false,
	}
	missingNetwork := &ports.DependencyError{
		Service: "runtime-egress", Code: "agent_network_not_found", Retryable: false,
	}
	dependencies.inspectionErr = missingRuntime
	dependencies.fenceErr = missingNetwork
	dependencies.releaseErr = missingNetwork
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(710, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-absent", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("delete absent Agent Runtime: %v", err)
	}
	wantCalls := []string{
		"egress.network.get", "runtime.inspect", "egress.network.get",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if store.begin.Operation.SourceRuntimeAbsent ||
		store.begin.Operation.SourceRuntimeRevision != "" ||
		store.begin.Operation.SourceRuntimeAbsenceProof != nil ||
		store.state.Operation.SourceRuntimeAbsenceProof == nil ||
		store.state.Operation.SourceRuntimeAbsenceProof.Reason != "runtime_not_found" ||
		result.Operation.State != domain.OperationCompleted {
		t.Fatalf("absent Runtime delete = %+v begin=%+v", result, store.begin)
	}
}

func TestDeleteAgentRejectsForeignRuntimeWhenProjectionHasNoRevision(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeUnknown)
	base.Agent.RuntimeRevision = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.inspection = ports.RuntimeInspection{
		AgentID: "another-agent", RuntimeRevision: "rtv_deleted_elsewhere",
		LifecycleState: "deleted", Health: "absent",
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(715, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-wrong-agent", AgentID: base.Agent.AgentID,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("foreign Runtime inspection accepted: %+v %v", result, err)
	}
	if !slices.Contains(dependencies.calls, "runtime.inspect") {
		t.Fatalf("missing authoritative Runtime inspection: %v", dependencies.calls)
	}
	if store.state.Operation.Phase != domain.PhaseNetworkFence || slices.Contains(dependencies.calls, "egress.release") {
		t.Fatalf("foreign Runtime crossed cleanup barrier: %+v %v", store.state.Operation, dependencies.calls)
	}
}

func TestDeleteAgentWaitsForActiveRun(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDeleteDependencies(base.Agent)
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(720, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-draining", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("start draining Agent: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || len(dependencies.calls) != 0 {
		t.Fatalf("draining Agent crossed deletion barrier: result=%+v calls=%v", result, dependencies.calls)
	}
}

func TestDeleteAgentExpiredDeadlineDoesNotQueryACPOrMutateRuntime(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	now := time.Unix(900, 0).UTC()
	service := newTestLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: now}, time.Minute,
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	state := ports.AgentDeleteState{
		Agent: base.Agent,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-delete-expired-drain", RequestFingerprint: "fingerprint",
			DrainDeadlineAt: testDrainDeadline(now.Add(-time.Minute)),
			AgentID:         base.Agent.AgentID, Kind: domain.OperationDelete,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			CreatedAt: now.Add(-2 * time.Minute), UpdatedAt: now.Add(-2 * time.Minute),
		},
	}
	store.state = state
	store.replayed = true

	settled, err := service.settleDeleteDrain(context.Background(), state)
	if err != nil {
		t.Fatalf("settle expired but empty drain: %v", err)
	}
	if settled.Operation.State != domain.OperationFailed || settled.Operation.ErrorCode != "drain_timeout" || len(dependencies.calls) != 0 {
		t.Fatalf("settled phase = %q", settled.Operation.Phase)
	}
}

func TestDeleteAgentKeepsUnknownRuntimeEffectNonterminal(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.runtime = ports.RuntimeOperation{
		State: "unknown", Effect: "unknown", RuntimeRevision: base.Agent.RuntimeRevision,
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(730, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-unknown", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("delete Agent with unknown Runtime effect: %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeDelete || store.published.RequestID != "" {
		t.Fatalf("unknown Runtime effect became terminal: result=%+v publish=%+v", result, store.published)
	}
	if reflect.DeepEqual(dependencies.calls, []string{
		"egress.attachment.closed", "runtime.delete", "egress.release",
	}) {
		t.Fatal("network was released after unknown Runtime deletion")
	}
}

func TestDeleteAgentCompletedRetryDoesNotRepeatEffects(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAbsent)
	base.Agent.LifecycleState = domain.AgentDeleted
	base.Agent.ActivationState = ""
	base.Agent.DesiredState = domain.DesiredDeleted
	state := ports.AgentDeleteState{
		Agent: base.Agent,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-delete-replay", RequestFingerprint: "fingerprint",
			AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
		},
	}
	store := &deleteLifecycleStoreStub{state: state, replayed: true}
	dependencies := newDeleteDependencies(base.Agent)
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(740, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{
		RequestID: "request-delete-replay", AgentID: base.Agent.AgentID,
	})
	if err != nil {
		t.Fatalf("replay delete Agent: %v", err)
	}
	if len(dependencies.calls) != 0 || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("completed retry repeated effects: result=%+v calls=%v", result, dependencies.calls)
	}
}

type deleteDependenciesStub struct {
	calls                   []string
	attachment              ports.NetworkAttachment
	fenceErr                error
	releaseErr              error
	runtime                 ports.RuntimeOperation
	runtimeErr              error
	inspection              ports.RuntimeInspection
	inspectionErr           error
	expectedRuntimeRevision string
	runtimeRequestID        string
	runtimeAgentID          string
	attachmentClosed        bool
}

func newDeleteDependencies(agent ports.AgentRecord) *deleteDependenciesStub {
	attachment := validLifecycleNetwork()
	attachment.AgentID = agent.AgentID
	attachment.State = ports.NetworkStateActive
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	return &deleteDependenciesStub{
		attachment: attachment,
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision: "rtv_99999999999999999999999999999999",
			LifecycleState:  "deleted", Health: "absent",
		},
		inspection: ports.RuntimeInspection{
			AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
			RuntimeExecutionID: agent.RuntimeExecutionID,
			MCPEndpoint:        agent.RuntimeMCPEndpoint, LifecycleState: "provisioned", Health: "healthy",
		},
	}
}

func (dependency *deleteDependenciesStub) ReleaseAgentNetwork(
	_ context.Context, agentID string, expectedResourceVersion uint64,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.release")
	if dependency.releaseErr != nil {
		return ports.NetworkAttachment{}, dependency.releaseErr
	}
	result := dependency.attachment
	result.AgentID = agentID
	result.State = ports.NetworkStateQuarantined
	result.NetworkResourceVersion = expectedResourceVersion + 1
	result.AttachmentState = ports.NetworkAttachmentClosed
	dependency.attachment = result
	return result, nil
}

func (dependency *deleteDependenciesStub) DeleteRuntime(
	_ context.Context, requestID string, agentID string, expected string,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.delete")
	dependency.runtimeRequestID = requestID
	dependency.runtimeAgentID = agentID
	dependency.expectedRuntimeRevision = expected
	return dependency.runtime, dependency.runtimeErr
}

func (dependency *deleteDependenciesStub) InspectRuntime(
	context.Context, string,
) (ports.RuntimeInspection, error) {
	dependency.calls = append(dependency.calls, "runtime.inspect")
	return dependency.inspection, dependency.inspectionErr
}

func (dependency *deleteDependenciesStub) GetAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.network.get")
	if dependency.fenceErr != nil {
		return ports.NetworkAttachment{}, dependency.fenceErr
	}
	result := dependency.attachment
	result.AgentID = agentID
	return result, nil
}

func (dependency *deleteDependenciesStub) SetAgentNetworkAttachment(
	_ context.Context, agentID string, state string, expectedResourceVersion uint64, runtimeEndpoint string, tunnelKeyID string) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.attachment."+state)
	if dependency.fenceErr != nil {
		return ports.NetworkAttachment{}, dependency.fenceErr
	}
	result := dependency.attachment
	result.AgentID = agentID
	result.State = ports.NetworkStateActive
	result.AttachmentState = state
	result.RuntimeEndpoint = runtimeEndpoint
	result.TunnelKeyID = tunnelKeyID
	result.AttachmentResourceVersion = expectedResourceVersion + 1
	dependency.attachment = result
	dependency.attachmentClosed = state == ports.NetworkAttachmentClosed
	return result, nil
}

func (dependency *deleteDependenciesStub) EnsureAgentNetwork(
	context.Context, string,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network ensure")
}

func (dependency *deleteDependenciesStub) InitializeRuntime(
	context.Context, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime initialize")
}

func (dependency *deleteDependenciesStub) UpdateRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime update")
}

func (dependency *deleteDependenciesStub) DisableRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime disable")
}

func (dependency *deleteDependenciesStub) EnableRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime enable")
}

type deleteLifecycleStoreStub struct {
	lifecycleStoreStub
	base         ports.AgentDeleteBase
	begin        ports.BeginAgentDelete
	state        ports.AgentDeleteState
	replayed     bool
	drainBlocked bool
	published    ports.PublishAgentDelete
}

func (store *deleteLifecycleStoreStub) GetAgentDeleteBase(
	context.Context, string,
) (ports.AgentDeleteBase, error) {
	return store.base, nil
}

func (store *deleteLifecycleStoreStub) ReplayAgentDelete(
	context.Context, string, string,
) (ports.AgentDeleteState, bool, error) {
	return store.state, store.replayed, nil
}

func (store *deleteLifecycleStoreStub) BeginAgentDelete(
	_ context.Context, input ports.BeginAgentDelete,
) (ports.AgentDeleteState, bool, error) {
	store.begin = input
	if store.replayed {
		return store.state, true, nil
	}
	agent := store.base.Agent
	agent.DesiredState = domain.DesiredDeleted
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	store.state = ports.AgentDeleteState{Agent: agent, Operation: input.Operation}
	store.replayed = true
	return store.state, false, nil
}

func (store *deleteLifecycleStoreStub) AdvanceAgentDelete(
	_ context.Context, input ports.AdvanceAgentDelete,
) (ports.AgentDeleteState, error) {
	if input.SourceRuntimeInspection != nil {
		store.state.Operation.SourceRuntimeInspection = input.SourceRuntimeInspection
		store.state.Operation.SourceRuntimeRevision = input.SourceRuntimeInspection.RuntimeRevision
	}
	if input.SourceRuntimeAbsenceProof != nil {
		store.state.Operation.SourceRuntimeAbsent = true
		store.state.Operation.SourceRuntimeAbsenceProof = input.SourceRuntimeAbsenceProof
	}
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
	if input.NetworkReleaseOutcome != "" {
		store.state.Operation.NetworkReleaseOutcome = input.NetworkReleaseOutcome
		if input.NetworkReleaseOutcome == ports.NetworkReleaseAuthoritativeNone {
			store.state.Operation.NetworkAttachment = nil
		}
	}
	return store.state, nil
}

func (store *deleteLifecycleStoreStub) PublishAgentDelete(
	_ context.Context, input ports.PublishAgentDelete,
) (ports.AgentDeleteState, error) {
	store.published = input
	store.state.Agent.DesiredState = domain.DesiredDeleted
	store.state.Agent.LifecycleState = domain.AgentDeleted
	store.state.Agent.ActivationState = ""
	store.state.Agent.RuntimeState = domain.RuntimeAbsent
	store.state.Agent.AgentSpecRevisionID = ""
	store.state.Agent.ExecutionRevisionID = ""
	store.state.Agent.RuntimeRevision = ""
	store.state.Agent.RuntimeExecutionID = ""
	store.state.Agent.RuntimeMCPEndpoint = ""
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.AggregateSequence = input.DeletedEvent.AggregateSequence
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
	store.state.Operation.ChildRequestID = ""
	return store.state, nil
}

func deleteAgentBase(state domain.RuntimeState) ports.AgentDeleteBase {
	now := time.Unix(600, 0).UTC()
	return ports.AgentDeleteBase{Agent: ports.AgentRecord{
		AgentID: "agent-delete", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Delete Agent", DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: state,
		AccessRevision: "access-revision-delete", AgentSpecRevisionID: "spec-delete",
		ExecutionRevisionID:               "execution-delete",
		LastSuccessfulExecutionRevisionID: "execution-delete",
		RuntimeRevision:                   "rtv_11111111111111111111111111111111",
		RuntimeExecutionID:                "runtime-execution-delete",
		RuntimeMCPEndpoint:                "http://runtime-delete:8091/mcp",
		AggregateSequence:                 4, CreatedAt: now, UpdatedAt: now,
	}}
}

var _ ports.LifecycleStore = (*deleteLifecycleStoreStub)(nil)
var _ ports.EgressClient = (*deleteDependenciesStub)(nil)
var _ ports.RuntimeClient = (*deleteDependenciesStub)(nil)

func (store *deleteLifecycleStoreStub) GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error) {
	return store.state.Operation, nil
}
