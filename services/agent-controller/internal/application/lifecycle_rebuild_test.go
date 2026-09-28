package application

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRebuildAgentReplacesRuntimeAndPublishesTargetSpecAtomically(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	fenced := validLifecycleNetwork()
	fenced.AgentID = base.Agent.AgentID
	dependencies := &rebuildDependenciesStub{
		network: fenced,
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision:    "rtv_22222222222222222222222222222222",
			RuntimeExecutionID: "",
			MCPEndpoint:        "",
			LifecycleState:     "provisioned", Health: "unknown",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-agent", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent: %v", err)
	}

	assertResourceID(t, "agentspec", store.begin.TargetSpec.ID)
	assertResourceID(t, "event", store.begin.RequestedEvent.EventID)
	assertResourceID(t, "event", store.published.RebuiltEvent.EventID)
	assertResourceID(t, "accessrev", store.published.AccessRevision)
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.update", "egress.attachment.open",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if dependencies.expectedRuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("expected Runtime revision = %q", dependencies.expectedRuntimeRevision)
	}
	if dependencies.runtimeConfiguration.ImageRef != template.Snapshot().Runtime.ImageRef ||
		dependencies.runtimeConfiguration.Network.State != "active" {
		t.Fatalf("Runtime update configuration = %+v", dependencies.runtimeConfiguration)
	}
	if !reflect.DeepEqual(dependencies.runtimeConfiguration.MCPServers, template.Snapshot().Runtime.MCPServers) {
		t.Fatal("rebuild did not forward target MCP configuration")
	}
	if store.begin.TargetSpec.Revision != base.NextSpecRevision ||
		store.begin.TargetSpec.Snapshot.TemplateRevision != 1 {
		t.Fatalf("target Agent spec = %+v", store.begin.TargetSpec)
	}
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		result.Operation.State != domain.OperationCompleted ||
		result.Agent.AgentSpecRevisionID != store.begin.TargetSpec.ID ||
		result.Agent.ExecutionRevisionID != "" {
		t.Fatalf("rebuild result = %+v", result)
	}
	if store.published.RebuiltEvent.EventType != ports.EventAgentRebuilt {
		t.Fatalf("rebuild publication = %+v", store.published)
	}
}

func TestRebuildAgentTreatsAlreadyClosedAttachmentAsLostResponseReplay(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	network.AttachmentState = ports.NetworkAttachmentClosed
	dependencies := &rebuildDependenciesStub{
		network: network, attachmentClosed: true,
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision:    "rtv_33333333333333333333333333333333",
			RuntimeExecutionID: "",
			MCPEndpoint:        "",
			LifecycleState:     "provisioned", Health: "unknown",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(105, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-closed-replay", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent after lost close response: %v", err)
	}
	wantCalls := []string{"egress.get", "runtime.update", "egress.attachment.open"}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
	if result.Operation.State != domain.OperationCompleted {
		t.Fatalf("replayed close rebuild = %+v", result)
	}
}

func TestRebuildAgentWaitsForActiveRunWithoutExternalEffects(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &rebuildLifecycleStoreStub{
		base: rebuildLifecycleBase(t, template, model), drainBlocked: true,
	}
	dependencies := &rebuildDependenciesStub{}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(110, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-drain", AgentID: store.base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent while draining: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("draining operation = %+v", result.Operation)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("draining rebuild called dependencies: %v", dependencies.calls)
	}
}

func TestRebuildAgentDrainTimeoutPreservesExecutableSource(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	createdAt := time.Unix(100, 0).UTC()
	state := ports.AgentRebuildState{
		Agent: base.Agent, SourceSpec: base.ConfiguredSpec,
		SourceExecution: base.SourceExecution, TargetSpec: base.ConfiguredSpec,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-timeout", RequestFingerprint: "fingerprint",
			DrainDeadlineAt: testDrainDeadline(createdAt.Add(5 * time.Minute)),
			AgentID:         base.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.ConfiguredSpec.ID,
			SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      base.ConfiguredSpec.ID,
			CreatedAt:                 createdAt, UpdatedAt: createdAt,
		},
	}
	state.Agent.ActiveOperationRequestID = state.Operation.RequestID
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true, drainBlocked: true}
	dependencies := &rebuildDependenciesStub{}
	service := newTestLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: createdAt.Add(6 * time.Minute)}, 5*time.Minute, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: state.Operation.RequestID, AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("timeout rebuild: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "run_drain_timeout" ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeAvailable) ||
		result.Agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		!store.failed.PreserveExecutable {
		t.Fatalf("timeout result = %+v failed=%+v", result, store.failed)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("timeout rebuild called dependencies: %v", dependencies.calls)
	}
}

func TestRebuildAgentExpiredDeadlineDoesNotQueryACPOrMutateRuntime(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	now := time.Unix(160, 0).UTC()
	state := ports.AgentRebuildState{
		Agent: base.Agent, SourceSpec: base.ConfiguredSpec,
		SourceExecution: base.SourceExecution, TargetSpec: base.ConfiguredSpec,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-expired-drain", RequestFingerprint: "fingerprint",
			DrainDeadlineAt: testDrainDeadline(now.Add(-time.Minute)),
			AgentID:         base.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			CreatedAt: now.Add(-2 * time.Minute), UpdatedAt: now.Add(-2 * time.Minute),
		},
	}
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true}
	dependencies := &rebuildDependenciesStub{}
	service := newTestLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: now}, time.Minute, WithLifecycleExecution(testExecutionForStore(

			store)))

	settled, err := service.settleRebuildDrain(context.Background(), state)
	if err != nil {
		t.Fatalf("settle expired but empty rebuild drain: %v", err)
	}
	if settled.Operation.State != domain.OperationFailed || store.failed.Code != "run_drain_timeout" || len(dependencies.calls) != 0 {
		t.Fatalf("settled rebuild phase = %q failed=%+v", settled.Operation.Phase, store.failed)
	}
}

func TestRebuildAgentKnownRuntimeFailureRestoresPolicyAndSource(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	dependencies := &rebuildDependenciesStub{
		network: network,
		runtime: ports.RuntimeOperation{
			State: "failed", Effect: "not_started", ErrorCode: "image_not_found",
		},
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			RuntimeExecutionID: base.SourceExecution.RuntimeExecutionID,
			MCPEndpoint:        base.SourceExecution.RuntimeMCPEndpoint,
			LifecycleState:     "provisioned", Health: "healthy",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(115, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-runtime-failed", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("known Runtime failure: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "image_not_found" ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeAvailable) ||
		result.Agent.RuntimeRevision != base.Agent.RuntimeRevision || !store.failed.PreserveExecutable {
		t.Fatalf("known Runtime failure result = %+v failed=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.update", "runtime.inspect",
		"egress.get", "egress.attachment.open",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("dependency order = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestRebuildAgentRuntimeNotFoundRemainsRunningAndFenced(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	missing := &ports.DependencyError{
		Service: "runtime-controller", Code: "runtime_not_found", Retryable: false,
	}
	dependencies := &rebuildDependenciesStub{
		network: network, runtimeErr: missing, inspectionErr: missing,
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(117, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-runtime-missing", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("rebuild Agent runtime_not_found error = %v", err)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseRuntimeUpdate ||
		result.Agent.ActiveOperationRequestID == "" || store.failed.RequestID != "" {
		t.Fatalf("runtime_not_found rebuild result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.update", "runtime.inspect",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("Runtime-absence rebuild calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestRebuildAgentDeletedRuntimeInspectionFailsClosedAndReleasesBlockedRun(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	network := validLifecycleNetwork()
	network.AgentID = base.Agent.AgentID
	dependencies := &rebuildDependenciesStub{
		network: network,
		runtimeErr: &ports.DependencyError{
			Service: "runtime-controller", Code: "runtime_drift", Retryable: false,
		},
		inspection: ports.RuntimeInspection{
			AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "deleted", Health: "absent",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(118, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	traceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	spanID := trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	}))

	result, err := executeRebuildForTest(service, ctx, RebuildAgentInput{
		RequestID: "request-rebuild-runtime-deleted", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent after deleted Runtime inspection: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		(result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		store.failed.RuntimeAbsenceProof == nil ||
		store.failed.RuntimeAbsenceProof.Reason != "runtime_deleted" ||
		store.failed.FailedEvent.TraceID != traceID.String() {
		t.Fatalf("deleted-Runtime rebuild result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.get", "egress.attachment.closed", "runtime.update", "runtime.inspect",
	}
	if !reflect.DeepEqual(dependencies.calls, wantCalls) {
		t.Fatalf("deleted-Runtime rebuild calls = %v, want %v", dependencies.calls, wantCalls)
	}
}

func TestRebuildAgentCompletedReplayDoesNotRepeatDependencies(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	state := completedRebuildState(t, base)
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true}
	dependencies := &rebuildDependenciesStub{}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(120, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-agent", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("replay completed rebuild: %v", err)
	}
	if len(dependencies.calls) != 0 || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("completed replay = %+v calls=%v", result, dependencies.calls)
	}
}

func TestRebuildAgentReturnsStableAgentStateErrors(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	tests := []struct {
		name    string
		prepare func(*rebuildLifecycleStoreStub)
		want    error
	}{
		{
			name:    "missing",
			prepare: func(store *rebuildLifecycleStoreStub) { store.baseErr = ports.ErrNotFound },
			want:    ErrAgentNotFound,
		},
		{
			name: "not ready",
			prepare: func(store *rebuildLifecycleStoreStub) {
				store.base.Agent.LifecycleState = domain.AgentNotCreated
				store.base.Agent.ActivationState = ""
			},
			want: ErrAgentNotReady,
		},
		{
			name: "busy",
			prepare: func(store *rebuildLifecycleStoreStub) {
				store.base.Agent.ActiveOperationRequestID = "request-other-operation"
			},
			want: ErrLifecycleConflict,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			store := &rebuildLifecycleStoreStub{base: base}
			testCase.prepare(store)
			dependencies := &rebuildDependenciesStub{}
			service := newTestLifecycleService(
				lifecycleSpecSourceStub{template: template, model: model},
				store, dependencies, dependencies, fixedClock{now: time.Unix(125, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

					store)))

			_, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
				RequestID: "request-rebuild-state-error", AgentID: base.Agent.AgentID,
				TemplateID: "template-1", TemplateRevision: 1,
			})
			if !errors.Is(err, testCase.want) {
				t.Fatalf("error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestRebuildAgentRejectsChangedNetworkBeforePublication(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	fenced := validLifecycleNetwork()
	fenced.AgentID = base.Agent.AgentID
	changed := fenced
	changed.State = "active"
	changed.TunnelIPv4 = "100.64.0.99"
	dependencies := &rebuildDependenciesStub{
		network: fenced, ensuredNetwork: changed,
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision:    "rtv_33333333333333333333333333333333",
			RuntimeExecutionID: "",
			MCPEndpoint:        "",
			LifecycleState:     "provisioned", Health: "unknown",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(130, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-changed-network", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("rebuild Agent error = %v", err)
	}
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeAvailable) ||
		result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("changed-network result = %+v", result)
	}
	if store.published.RequestID != "" {
		t.Fatalf("changed network was published: %+v", store.published)
	}
}

func TestRebuildAgentKeepsAmbiguousRuntimeUpdateReplayable(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	fenced := validLifecycleNetwork()
	fenced.AgentID = base.Agent.AgentID
	dependencies := &rebuildDependenciesStub{
		network: fenced,
		runtime: ports.RuntimeOperation{
			State: "unknown", Effect: "unknown",
			RuntimeRevision: "rtv_44444444444444444444444444444444",
		},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(140, 0).UTC()}, WithLifecycleExecution(testExecutionForStore(

			store)))

	result, err := executeRebuildForTest(service, context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-unknown", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent with ambiguous Runtime: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeUpdate ||
		result.Operation.State != domain.OperationRunning || store.failed.RequestID != "" {
		t.Fatalf("ambiguous Runtime result = %+v failed=%+v", result, store.failed)
	}
}

type rebuildDependenciesStub struct {
	calls                   []string
	network                 ports.NetworkAttachment
	ensuredNetwork          ports.NetworkAttachment
	runtime                 ports.RuntimeOperation
	runtimeErr              error
	fenceErr                error
	inspection              ports.RuntimeInspection
	inspectionErr           error
	expectedRuntimeRevision string
	runtimeRequestID        string
	runtimeAgentID          string
	runtimeConfiguration    ports.RuntimeConfiguration
	attachmentClosed        bool
}

func (dependency *rebuildDependenciesStub) EnsureAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	result := dependency.ensuredNetwork
	if result.AgentID == "" {
		result = dependency.network
		result.State = "active"
	}
	result.AgentID = agentID
	return result, nil
}

func (dependency *rebuildDependenciesStub) GetAgentNetwork(
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
	if result.AttachmentResourceVersion == 0 {
		result.AttachmentResourceVersion = 1
	}
	return result, nil
}

func (dependency *rebuildDependenciesStub) SetAgentNetworkAttachment(
	_ context.Context, agentID string, state string, expectedResourceVersion uint64,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.attachment."+state)
	if state == ports.NetworkAttachmentClosed && dependency.fenceErr != nil {
		return ports.NetworkAttachment{}, dependency.fenceErr
	}
	result := dependency.network
	if state == ports.NetworkAttachmentOpen && dependency.ensuredNetwork.AgentID != "" {
		result = dependency.ensuredNetwork
	}
	result.AgentID = agentID
	result.State = ports.NetworkStateActive
	result.AttachmentState = state
	result.AttachmentResourceVersion = expectedResourceVersion + 1
	dependency.network = result
	dependency.attachmentClosed = state == ports.NetworkAttachmentClosed
	return result, nil
}

func (dependency *rebuildDependenciesStub) ReleaseAgentNetwork(
	context.Context, string, uint64,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network release")
}

func (dependency *rebuildDependenciesStub) InitializeRuntime(
	context.Context, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime initialize")
}

func (dependency *rebuildDependenciesStub) UpdateRuntime(
	_ context.Context, requestID string, agentID string, expectedRevision string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.update")
	dependency.runtimeRequestID = requestID
	dependency.runtimeAgentID = agentID
	dependency.expectedRuntimeRevision = expectedRevision
	dependency.runtimeConfiguration = configuration
	return dependency.runtime, dependency.runtimeErr
}

func (dependency *rebuildDependenciesStub) DisableRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime disable")
}

func (dependency *rebuildDependenciesStub) EnableRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime enable")
}

func (dependency *rebuildDependenciesStub) DeleteRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime delete")
}

func (dependency *rebuildDependenciesStub) InspectRuntime(
	_ context.Context, _ string,
) (ports.RuntimeInspection, error) {
	dependency.calls = append(dependency.calls, "runtime.inspect")
	return dependency.inspection, dependency.inspectionErr
}

type rebuildLifecycleStoreStub struct {
	lifecycleStoreStub
	base         ports.AgentLifecycleBase
	baseErr      error
	begin        ports.BeginAgentRebuild
	state        ports.AgentRebuildState
	replayed     bool
	drainBlocked bool
	published    ports.PublishAgentRebuild
	failed       ports.FailAgentRebuild
}

func (store *rebuildLifecycleStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return store.base, store.baseErr
}

func (store *rebuildLifecycleStoreStub) GetAgentEnableBase(context.Context, string) (ports.AgentEnableBase, error) {
	return ports.AgentEnableBase{Agent: store.base.Agent}, nil
}

func (store *rebuildLifecycleStoreStub) ReplayAgentRebuild(
	context.Context, string, string,
) (ports.AgentRebuildState, bool, error) {
	return store.state, store.replayed, nil
}

func (store *rebuildLifecycleStoreStub) BeginAgentRebuild(
	_ context.Context, input ports.BeginAgentRebuild,
) (ports.AgentRebuildState, bool, error) {
	store.begin = input
	if store.replayed {
		return store.state, true, nil
	}
	agent := store.base.Agent
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	store.state = ports.AgentRebuildState{
		Agent: agent, SourceSpec: store.base.ConfiguredSpec,
		SourceExecution: store.base.SourceExecution,
		TargetSpec:      input.TargetSpec, Operation: input.Operation,
		LegacyMigration: input.LegacyMigration,
	}
	store.replayed = true
	return store.state, false, nil
}

func (store *rebuildLifecycleStoreStub) AdvanceAgentRebuild(
	_ context.Context, input ports.AdvanceAgentRebuild,
) (ports.LifecycleAdvanceResult, error) {
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
	return ports.LifecycleAdvanceResult{Agent: store.state.Agent, Operation: store.state.Operation}, nil
}

func (store *rebuildLifecycleStoreStub) PublishAgentRebuild(
	_ context.Context, input ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	store.published = input
	store.state.Agent.AgentSpecRevisionID = store.state.TargetSpec.ID
	store.state.Agent.ExecutionRevisionID = ""
	store.state.Agent.RuntimeRevision = store.state.Operation.RuntimeResult.RuntimeRevision
	store.state.Agent.RuntimeExecutionID = ""
	store.state.Agent.RuntimeMCPEndpoint = ""
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.LifecycleState, store.state.Agent.ActivationState, store.state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	store.state.Agent.AggregateSequence = input.RebuiltEvent.AggregateSequence
	store.state.Agent.UpdatedAt = input.Now
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
	store.state.Operation.ChildRequestID = ""
	store.state.Operation.UpdatedAt = input.Now
	return store.state, nil
}

func (store *rebuildLifecycleStoreStub) FailAgentRebuild(
	_ context.Context, input ports.FailAgentRebuild,
) (ports.AgentRebuildState, error) {
	input.FailedEvent.AggregateSequence = input.ExpectedAggregateSequence + 1
	store.failed = input
	store.state.Operation.SourceRuntimeAbsenceProof = input.RuntimeAbsenceProof
	if !input.PreserveExecutable {
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

func rebuildLifecycleBase(
	t *testing.T, template domain.TemplateRevision, model domain.ModelProfileRevision,
) ports.AgentLifecycleBase {
	t.Helper()
	created := completedCreateState(t, template, model)
	created.Agent.RuntimeRevision = "rtv_11111111111111111111111111111111"
	created.Spec.CanonicalDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	return ports.AgentLifecycleBase{
		Agent: created.Agent, ConfiguredSpec: created.Spec,
		SourceExecution: ports.ExecutionRecord{
			ID: created.Agent.ExecutionRevisionID, AgentID: created.Agent.AgentID, Revision: 1,
			AgentSpecRevisionID: created.Spec.ID, RuntimeRevision: created.Agent.RuntimeRevision,
			RuntimeExecutionID: created.Agent.RuntimeExecutionID,
			RuntimeMCPEndpoint: created.Agent.RuntimeMCPEndpoint,
		},
		NextSpecRevision: 2, NextExecutionRevision: 2,
	}
}

func completedRebuildState(t *testing.T, base ports.AgentLifecycleBase) ports.AgentRebuildState {
	t.Helper()
	target := base.ConfiguredSpec
	target.ID = "agentspec-rebuilt"
	target.Revision = base.NextSpecRevision
	agent := base.Agent
	agent.AgentSpecRevisionID = target.ID
	agent.ExecutionRevisionID = "execution-rebuilt"
	agent.LastSuccessfulExecutionRevisionID = "execution-rebuilt"
	return ports.AgentRebuildState{
		Agent: agent, SourceSpec: base.ConfiguredSpec,
		SourceExecution: base.SourceExecution, TargetSpec: target,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-agent", RequestFingerprint: "fingerprint",
			AgentID: agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
			SourceSpecRevisionID:      base.ConfiguredSpec.ID,
			SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      target.ID,
		},
	}
}

func (store *rebuildLifecycleStoreStub) GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error) {
	return store.state.Operation, nil
}
