package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type failedCreateRebuildDependencies struct {
	*rebuildDependenciesStub
	initializeCalls  []string
	initializeResult ports.RuntimeOperation
	initializeErr    error
	ensureErrs       []error
	inspected        bool
	updated          bool
}

func (dependency *failedCreateRebuildDependencies) InitializeRuntime(
	_ context.Context, requestID string, _ string, _ ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.initializeCalls = append(dependency.initializeCalls, requestID)
	return dependency.initializeResult, dependency.initializeErr
}

func (dependency *failedCreateRebuildDependencies) UpdateRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.updated = true
	return ports.RuntimeOperation{}, errors.New("marker retry must never Update an old Runtime")
}

func (dependency *failedCreateRebuildDependencies) InspectRuntime(
	_ context.Context, agentID string,
) (ports.RuntimeInspection, error) {
	dependency.inspected = true
	return peerInspectionForTest(agentID, dependency.initializeResult.RuntimeRevision), nil
}

func (dependency *failedCreateRebuildDependencies) EnsureAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(
		dependency.calls, "egress.ensure")
	if len(dependency.ensureErrs) > 0 {
		err := dependency.ensureErrs[0]
		dependency.ensureErrs = dependency.ensureErrs[1:]
		return ports.NetworkAttachment{}, err
	}
	return dependency.rebuildDependenciesStub.EnsureAgentNetwork(context.Background(), agentID)
}

func failedCreateRetryBase(t *testing.T) ports.AgentLifecycleBase {
	t.Helper()
	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	base.Agent.LifecycleState = domain.AgentNotCreated
	base.Agent.ActivationState = ""
	base.Agent.AgentSpecRevisionID = ""
	base.Agent.ExecutionRevisionID = ""
	base.Agent.LastSuccessfulExecutionRevisionID = ""
	base.Agent.RuntimeRevision = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""
	base.Agent.FailureStage = string(domain.PhaseNetworkEnsure)
	base.Agent.FailureCode = "phase_deadline_exceeded"
	base.ConfiguredSpec.ID, base.ConfiguredSpec.Revision = "spec-source", 1
	base.ConfiguredSpec.AgentID = base.Agent.AgentID
	base.SourceExecution = ports.ExecutionRecord{}
	now := time.Unix(100, 0).UTC()
	base.FailedCreateOperation = &ports.LifecycleOperationRecord{
		RequestID: "request-create-failed", RequestFingerprint: "fp",
		AgentID: base.Agent.AgentID, Kind: domain.OperationCreate,
		Phase: domain.PhaseNetworkEnsure, State: domain.OperationFailed,
		ErrorCode: "phase_deadline_exceeded", TargetSpecRevisionID: "spec-source",
		CreatedAt: now, UpdatedAt: now,
	}
	return base
}

func failedCreateRetryService(
	t *testing.T, base ports.AgentLifecycleBase, dependencies *failedCreateRebuildDependencies,
) (*LifecycleService, *rebuildLifecycleStoreStub) {
	t.Helper()
	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	retryNow := time.Now().UTC()
	store := &rebuildLifecycleStoreStub{base: base}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: retryNow},
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	return service, store
}

func failedCreateRetryInput(base ports.AgentLifecycleBase) RebuildAgentInput {
	return RebuildAgentInput{
		RequestID: "request-rebuild-retry", OrganizationID: base.Agent.OrganizationID,
		ActorPrincipalID: "actor-1", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	}
}

func TestFailedCreateRebuildCompletesInitializationRetry(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	attachment := validLifecycleNetwork()
	attachment.AgentID = base.Agent.AgentID
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	dependencies := &failedCreateRebuildDependencies{
		rebuildDependenciesStub: &rebuildDependenciesStub{network: attachment, ensuredNetwork: attachment},
		initializeResult: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision:    "rtv_33333333333333333333333333333333",
			RuntimeExecutionID: "", MCPEndpoint: "",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	service, store := failedCreateRetryService(t, base, dependencies)
	result, err := executeRebuildForTest(service, context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("failed-create rebuild: %v", err)
	}
	if result.Operation.State != domain.OperationCompleted {
		t.Fatalf("operation %+v", result.Operation)
	}
	begin := store.begin
	if begin.Operation.SourceFailedCreateRequestID != "request-create-failed" {
		t.Fatalf("marker %q", begin.Operation.SourceFailedCreateRequestID)
	}
	if begin.Operation.SourceSpecRevisionID != "spec-source" ||
		begin.Operation.SourceRuntimeRevision != "" ||
		begin.Operation.SourceExecutionRevisionID != "" ||
		begin.ExpectedSpecRevisionID != "spec-source" ||
		begin.ExpectedExecutionRevisionID != "" ||
		begin.ExpectedRuntimeRevision != "" {
		t.Fatalf("marker source record %+v", begin.Operation)
	}
	if store.published.RebuiltEvent.EventType != ports.EventAgentRebuilt ||
		store.state.Agent.LifecycleState != domain.AgentCreated ||
		store.state.Agent.ActivationState != domain.ActivationEnabled ||
		store.state.Operation.SourceFailedCreateRequestID != "request-create-failed" {
		t.Fatalf("published state %+v", store.state.Agent)
	}
	if len(dependencies.initializeCalls) != 1 || dependencies.updated {
		t.Fatalf("dependency calls %+v initialize=%v update=%v",
			dependencies.calls, dependencies.initializeCalls, dependencies.updated)
	}
	for _, call := range dependencies.calls {
		if call == "egress.get" {
			t.Fatalf("marker rebuild must not GetAgentNetwork: %v", dependencies.calls)
		}
	}
}

func TestFailedCreateRebuildRetriesTransientEgressFailure(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	attachment := validLifecycleNetwork()
	attachment.AgentID = base.Agent.AgentID
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	dependencies := &failedCreateRebuildDependencies{
		rebuildDependenciesStub: &rebuildDependenciesStub{network: attachment, ensuredNetwork: attachment},
		ensureErrs:              []error{errors.New("egress temporarily unavailable")},
		initializeResult: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision: "rtv_33333333333333333333333333333333",
			LifecycleState:  "provisioned", Health: "unknown",
		},
	}
	service, _ := failedCreateRetryService(t, base, dependencies)
	_, err := service.RebuildAgent(context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("admit rebuild: %v", err)
	}
	fingerprint, _ := rebuildAgentFingerprint(failedCreateRetryInput(base))
	state, found, err := service.store.ReplayAgentRebuild(context.Background(), "request-rebuild-retry", fingerprint)
	if err != nil || !found {
		t.Fatalf("replay %v found=%v", err, found)
	}
	var stepErr error
	for range 4 {
		state, stepErr = service.stepAgentRebuild(context.Background(), state)
		if stepErr != nil {
			break
		}
	}
	if stepErr == nil {
		t.Fatal("the fenced ensure attempt must surface the transient egress failure")
	}
	dependency := dependencies
	if len(dependency.calls) == 0 ||
		dependency.calls[0] != "egress.ensure" {
		t.Fatalf("expected ensure attempt: %v", dependency.calls)
	}
	if dependency.initializeCalls != nil {
		t.Fatal("runtime must not initialize before the network is fenced")
	}
	fencedChildRequestID := state.Operation.ChildRequestID
	state, stepErr = service.stepAgentRebuild(context.Background(), state)
	if stepErr != nil {
		t.Fatalf("retry with restored Egress must proceed: %v", stepErr)
	}
	if fencedChildRequestID != domain.ChildRequestID("request-rebuild-retry", domain.PhaseNetworkFence) {
		t.Fatalf("network retry used a different child request: %q", fencedChildRequestID)
	}
	for range 4 {
		state, stepErr = service.stepAgentRebuild(context.Background(), state)
		if stepErr != nil {
			t.Fatalf("retry phase %v", stepErr)
		}
		if state.Operation.State != domain.OperationRunning {
			break
		}
	}
	if state.Operation.State != domain.OperationCompleted ||
		len(dependencies.initializeCalls) != 1 ||
		dependencies.initializeCalls[0] != domain.ChildRequestID("request-rebuild-retry", domain.PhaseRuntimeUpdate) {
		t.Fatalf("retry must complete using one stable initialize request: op=%+v calls=%v",
			state.Operation, dependencies.initializeCalls)
	}
}

func TestFailedCreateRebuildDefiniteDependencyErrorFailsSource(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	attachment := validLifecycleNetwork()
	attachment.AgentID = base.Agent.AgentID
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	dependencies := &failedCreateRebuildDependencies{
		rebuildDependenciesStub: &rebuildDependenciesStub{network: attachment, ensuredNetwork: attachment},
		initializeErr:           &ports.DependencyError{Service: "runtime-controller", Code: "runtime_init_rejected", Cause: errors.New("definitive"), Retryable: false},
	}
	service, store := failedCreateRetryService(t, base, dependencies)
	result, err := executeRebuildForTest(service, context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("definitive dependency rejection is a business outcome: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		store.state.Agent.ActiveOperationRequestID != "" {
		t.Fatalf("failure state %+v", result.Operation)
	}
	if dependencies.inspected || dependencies.updated {
		t.Fatal("marker failure must not reconcile a source Runtime")
	}
}

func TestFailedCreateRebuildUnknownEffectStaysRetryable(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	attachment := validLifecycleNetwork()
	attachment.AgentID = base.Agent.AgentID
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	dependencies := &failedCreateRebuildDependencies{
		rebuildDependenciesStub: &rebuildDependenciesStub{network: attachment, ensuredNetwork: attachment},
		initializeResult:        ports.RuntimeOperation{State: "failed", Effect: "unknown"},
	}
	service, _ := failedCreateRetryService(t, base, dependencies)
	_, err := service.RebuildAgent(context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("admit rebuild: %v", err)
	}
	fingerprint, _ := rebuildAgentFingerprint(failedCreateRetryInput(base))
	state, found, err := service.store.ReplayAgentRebuild(context.Background(), "request-rebuild-retry", fingerprint)
	if err != nil || !found {
		t.Fatalf("replay %v found=%v", err, found)
	}
	var stepErr error
	for range 4 {
		state, stepErr = service.stepAgentRebuild(context.Background(), state)
		if stepErr != nil {
			break
		}
	}
	if stepErr == nil || !errors.Is(stepErr, ErrDependencyUnavailable) {
		t.Fatalf("unknown-effect result must remain retryable: %v", stepErr)
	}
	if dependencies.inspected || dependencies.updated {
		t.Fatal("unknown effect must not reconcile a source Runtime")
	}
}

func TestFailedCreateRebuildDefiniteInitializeFailurePreservesSource(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	attachment := validLifecycleNetwork()
	attachment.AgentID = base.Agent.AgentID
	attachment.AttachmentState = ports.NetworkAttachmentOpen
	dependencies := &failedCreateRebuildDependencies{
		rebuildDependenciesStub: &rebuildDependenciesStub{network: attachment, ensuredNetwork: attachment},
		initializeResult: ports.RuntimeOperation{
			State: "failed", Effect: "not_started",
			ErrorCode: "runtime_init_rejected", ErrorDetail: "definitive rejection",
		},
	}
	service, store := failedCreateRetryService(t, base, dependencies)
	result, err := executeRebuildForTest(service, context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("definitive initialize failure is a business outcome: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		store.state.Agent.ActiveOperationRequestID != "" {
		t.Fatalf("failure state %+v", result.Operation)
	}
	if dependencies.inspected || dependencies.updated {
		t.Fatal("marker failure must not reconcile a source Runtime")
	}
	if store.state.Agent.RuntimeRevision != "" || store.state.Agent.ExecutionRevisionID != "" {
		t.Fatal("failed marker retry must preserve the no-Runtime source")
	}
}

func TestFailedCreateRebuildRejectsForfeitedSource(t *testing.T) {
	t.Parallel()
	for _, mutate := range []func(*ports.AgentLifecycleBase){
		func(b *ports.AgentLifecycleBase) { b.FailedCreateOperation = nil },
		func(b *ports.AgentLifecycleBase) { b.Agent.LifecycleState = domain.AgentCreated },
		func(b *ports.AgentLifecycleBase) { b.Agent.RuntimeRevision = "runtime-1" },
		func(b *ports.AgentLifecycleBase) { b.Agent.RuntimeExecutionID = "exec-stale" },
		func(b *ports.AgentLifecycleBase) { b.FailedCreateOperation.Phase = domain.PhaseRuntimeInitialize },
		func(b *ports.AgentLifecycleBase) { b.FailedCreateOperation.ErrorCode = "lifecycle_cancelled" },
		func(b *ports.AgentLifecycleBase) { b.FailedCreateOperation.State = domain.OperationRunning },
	} {
		base := failedCreateRetryBase(t)
		mutate(&base)
		store := &rebuildLifecycleStoreStub{base: base}
		dependencies := &failedCreateRebuildDependencies{rebuildDependenciesStub: &rebuildDependenciesStub{}}
		service, _ := failedCreateRetryService(t, base, dependencies)
		service.store = store
		_, err := executeRebuildForTest(service, context.Background(), failedCreateRetryInput(base))
		if err == nil {
			t.Fatal("forfeited source must not admit a rebuild")
		}
		if store.begin.Operation.RequestID != "" {
			t.Fatal("rejected source must leave no admitted operation")
		}
	}
}

func TestFailedCreateRebuildSkillIntentUsesStoredSpecPointer(t *testing.T) {
	t.Parallel()
	base := failedCreateRetryBase(t)
	base.Agent.AgentSpecRevisionID = ""
	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &rebuildLifecycleStoreStub{base: base}
	prepared := &skillIntentStub{}
	retryNow := time.Now().UTC()
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, &rebuildDependenciesStub{}, &rebuildDependenciesStub{}, fixedClock{now: retryNow},
		WithLifecycleExecution(testExecutionForStore(store)),
		WithSkillPreparation(prepared, &skillPreparationClientStub{state: "ready"}),
	)
	_, err := service.RebuildAgent(context.Background(), failedCreateRetryInput(base))
	if err != nil {
		t.Fatalf("admit marker rebuild: %v", err)
	}
	if prepared.intent.ExpectedSpecRevisionID != "" {
		t.Fatalf("skill intent must carry the blank stored spec pointer, got %q",
			prepared.intent.ExpectedSpecRevisionID)
	}
	if store.begin.ExpectedSpecRevisionID != "spec-source" {
		t.Fatalf("admission must still freeze the failed-create spec, got %q",
			store.begin.ExpectedSpecRevisionID)
	}
	if prepared.intent.TargetSpec.TemplateID != "template-1" {
		t.Fatalf("target spec snapshot must be the rebuild target: %+v", prepared.intent.TargetSpec)
	}
}
