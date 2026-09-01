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
			RuntimeExecutionID: "runtime-execution-rebuilt",
			MCPEndpoint:        "http://runtime-rebuilt:8091/mcp",
			LifecycleState:     "ready", Health: "healthy",
		},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-agent", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent: %v", err)
	}

	wantCalls := []string{
		"egress.policy.get", "egress.fence", "egress.get", "egress.policy.get", "egress.reset",
		"runtime.update", "egress.policy.get", "egress.policy.assign", "egress.ensure",
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
	if store.begin.TargetSpec.Revision != base.NextSpecRevision ||
		store.begin.TargetSpec.Snapshot.TemplateRevision != 1 {
		t.Fatalf("target Agent spec = %+v", store.begin.TargetSpec)
	}
	if result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Operation.State != domain.OperationCompleted ||
		result.Agent.AgentSpecRevisionID != store.begin.TargetSpec.ID ||
		result.Agent.ExecutionRevisionID != store.published.Execution.ID {
		t.Fatalf("rebuild result = %+v", result)
	}
	if store.published.Execution.Revision != base.NextExecutionRevision ||
		store.published.RebuiltEvent.EventType != ports.EventAgentRebuilt {
		t.Fatalf("rebuild publication = %+v", store.published)
	}
	if store.runReleaseEvent.EventType != ports.EventRunAdmissionReleased ||
		store.runReleaseEvent.Data["release_reason"] != "runtime_replaced" ||
		store.runReleaseEvent.Data["source_runtime_revision"] != base.Agent.RuntimeRevision {
		t.Fatalf("rebuild Run release event = %+v", store.runReleaseEvent)
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
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(110, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
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
		Agent: base.Agent, SourceSpec: base.ExecutableSpec,
		SourceExecution: base.ExecutableExecution, TargetSpec: base.ExecutableSpec,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-timeout", RequestFingerprint: "fingerprint",
			AgentID: base.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.ExecutableSpec.ID,
			SourceExecutionRevisionID: base.ExecutableExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      base.ExecutableSpec.ID,
			CreatedAt:                 createdAt, UpdatedAt: createdAt,
		},
	}
	state.Agent.ActiveOperationRequestID = state.Operation.RequestID
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true, drainBlocked: true}
	dependencies := &rebuildDependenciesStub{}
	service := NewLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: createdAt.Add(6 * time.Minute)}, 5*time.Minute,
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
		RequestID: state.Operation.RequestID, AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("timeout rebuild: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "run_drain_timeout" ||
		result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		!store.failed.PreserveExecutable {
		t.Fatalf("timeout result = %+v failed=%+v", result, store.failed)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("timeout rebuild called dependencies: %v", dependencies.calls)
	}
}

func TestRebuildAgentRechecksDrainBeforeApplyingTimeout(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	now := time.Unix(160, 0).UTC()
	state := ports.AgentRebuildState{
		Agent: base.Agent, SourceSpec: base.ExecutableSpec,
		SourceExecution: base.ExecutableExecution, TargetSpec: base.ExecutableSpec,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-expired-drain", RequestFingerprint: "fingerprint",
			AgentID: base.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			CreatedAt: now.Add(-2 * time.Minute), UpdatedAt: now.Add(-2 * time.Minute),
		},
	}
	store := &rebuildLifecycleStoreStub{base: base, state: state, replayed: true}
	dependencies := &rebuildDependenciesStub{}
	service := NewLifecycleServiceWithDrainTimeout(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: now}, time.Minute,
	)

	settled, err := service.settleRebuildDrain(context.Background(), state)
	if err != nil {
		t.Fatalf("settle expired but empty rebuild drain: %v", err)
	}
	if settled.Operation.Phase != domain.PhaseNetworkFence || store.failed.Code != "" {
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
			RuntimeExecutionID: base.ExecutableExecution.RuntimeExecutionID,
			MCPEndpoint:        base.ExecutableExecution.RuntimeMCPEndpoint,
			LifecycleState:     "ready", Health: "healthy",
		},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(115, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-runtime-failed", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("known Runtime failure: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "image_not_found" ||
		result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Agent.RuntimeRevision != base.Agent.RuntimeRevision || !store.failed.PreserveExecutable {
		t.Fatalf("known Runtime failure result = %+v failed=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.fence", "egress.get", "egress.policy.get", "egress.reset",
		"runtime.update", "runtime.inspect",
		"egress.policy.get", "egress.policy.assign", "egress.ensure",
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
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(117, 0).UTC()},
	)
	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
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
		"egress.policy.get", "egress.fence", "egress.get", "egress.policy.get", "egress.reset",
		"runtime.update", "runtime.inspect",
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
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(118, 0).UTC()},
	)
	traceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	spanID := trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	}))

	result, err := service.RebuildAgent(ctx, RebuildAgentInput{
		RequestID: "request-rebuild-runtime-deleted", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("rebuild Agent after deleted Runtime inspection: %v", err)
	}
	if result.Operation.State != domain.OperationFailed ||
		result.Agent.LifecycleState != domain.AgentUnavailable ||
		store.failed.RuntimeAbsenceProof == nil ||
		store.failed.RuntimeAbsenceProof.Reason != "runtime_deleted" ||
		store.failed.RunReleaseEvent.Data["release_reason"] != "runtime_deleted" ||
		store.failed.RunReleaseEvent.TraceID != traceID.String() ||
		store.failed.FailedEvent.TraceID != traceID.String() {
		t.Fatalf("deleted-Runtime rebuild result=%+v failure=%+v", result, store.failed)
	}
	wantCalls := []string{
		"egress.policy.get", "egress.fence", "egress.get", "egress.policy.get", "egress.reset",
		"runtime.update", "runtime.inspect",
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
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(120, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
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
				store.base.Agent.LifecycleState = domain.AgentUnavailable
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
			service := NewLifecycleService(
				lifecycleSpecSourceStub{template: template, model: model},
				store, dependencies, dependencies, fixedClock{now: time.Unix(125, 0).UTC()},
			)
			_, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
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
			RuntimeExecutionID: "runtime-execution-changed",
			MCPEndpoint:        "http://runtime-changed:8091/mcp",
			LifecycleState:     "ready", Health: "healthy",
		},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(130, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
		RequestID: "request-rebuild-changed-network", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("rebuild Agent error = %v", err)
	}
	if result.Agent.LifecycleState != domain.AgentAvailable ||
		result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("changed-network result = %+v", result)
	}
	if store.published.Execution.ID != "" {
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
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(140, 0).UTC()},
	)

	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
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
	policyGets              int
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
	return result, nil
}

func (dependency *rebuildDependenciesStub) GetAgentPolicyAssignment(
	_ context.Context, agentID string,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.get")
	dependency.policyGets++
	policyID := "internet-enabled"
	resourceVersion := uint64(7)
	if dependency.policyGets > 1 {
		policyID = ports.BuiltinDenyAllPolicyID
		resourceVersion = 8
	}
	return ports.NetworkPolicyAssignment{
		AgentID: agentID, PolicyID: policyID, Revision: 1, ResourceVersion: resourceVersion,
	}, nil
}

func (dependency *rebuildDependenciesStub) AssignAgentPolicy(
	_ context.Context, assignment ports.NetworkPolicyAssignment, expectedResourceVersion uint64,
) (ports.NetworkPolicyAssignment, error) {
	dependency.calls = append(dependency.calls, "egress.policy.assign")
	assignment.ResourceVersion = expectedResourceVersion + 1
	return assignment, nil
}

func (dependency *rebuildDependenciesStub) FenceAgentNetwork(context.Context, string, uint64) error {
	dependency.calls = append(dependency.calls, "egress.fence")
	return dependency.fenceErr
}

func (dependency *rebuildDependenciesStub) ResetAgentFlows(context.Context, string, uint64) error {
	dependency.calls = append(dependency.calls, "egress.reset")
	return nil
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
	base            ports.AgentLifecycleBase
	baseErr         error
	begin           ports.BeginAgentRebuild
	state           ports.AgentRebuildState
	replayed        bool
	drainBlocked    bool
	published       ports.PublishAgentRebuild
	failed          ports.FailAgentRebuild
	runReleaseEvent ports.RunAdmissionEvent
}

func (store *rebuildLifecycleStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return store.base, store.baseErr
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
		Agent: agent, SourceSpec: store.base.ExecutableSpec,
		SourceExecution: store.base.ExecutableExecution,
		TargetSpec:      input.TargetSpec, Operation: input.Operation,
	}
	return store.state, false, nil
}

func (store *rebuildLifecycleStoreStub) SettleAgentRebuildDrain(
	_ context.Context, _ string, _ string, nextChildRequestID string, now time.Time,
) (ports.AgentRebuildState, error) {
	if store.drainBlocked {
		return store.state, nil
	}
	store.state.Operation.Phase = domain.PhaseNetworkFence
	store.state.Operation.ChildRequestID = nextChildRequestID
	store.state.Operation.UpdatedAt = now
	return store.state, nil
}

func (store *rebuildLifecycleStoreStub) RecordAgentRebuildPolicy(
	_ context.Context, _ string, _ string,
	assignment ports.NetworkPolicyAssignment, now time.Time,
) (ports.AgentRebuildState, error) {
	store.state.Operation.NetworkPolicyAssignment = &assignment
	store.state.Operation.UpdatedAt = now
	return store.state, nil
}

func (store *rebuildLifecycleStoreStub) AdvanceAgentRebuild(
	_ context.Context, input ports.AdvanceAgentRebuild,
) (ports.AgentRebuildState, error) {
	if input.RunReleaseEvent.EventID != "" {
		store.runReleaseEvent = input.RunReleaseEvent
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
	return store.state, nil
}

func (store *rebuildLifecycleStoreStub) PublishAgentRebuild(
	_ context.Context, input ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	store.published = input
	store.state.Agent.AgentSpecRevisionID = input.Execution.AgentSpecRevisionID
	store.state.Agent.ExecutionRevisionID = input.Execution.ID
	store.state.Agent.LastSuccessfulExecutionRevisionID = input.Execution.ID
	store.state.Agent.RuntimeRevision = input.Execution.RuntimeRevision
	store.state.Agent.RuntimeExecutionID = input.Execution.RuntimeExecutionID
	store.state.Agent.RuntimeMCPEndpoint = input.Execution.RuntimeMCPEndpoint
	store.state.Agent.ActiveOperationRequestID = ""
	store.state.Agent.LifecycleState = domain.AgentAvailable
	store.state.Agent.AggregateSequence = input.RebuiltEvent.AggregateSequence
	store.state.Agent.UpdatedAt = input.Now
	store.state.Operation.Phase = domain.PhaseCompleted
	store.state.Operation.State = domain.OperationCompleted
	store.state.Operation.RecoveryOwner = ""
	store.state.Operation.RecoveryLeaseUntil = nil
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
	store.state.Operation.RecoveryOwner = ""
	store.state.Operation.RecoveryLeaseUntil = nil
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
		Agent: created.Agent, ExecutableSpec: created.Spec,
		ExecutableExecution: ports.ExecutionRecord{
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
	target := base.ExecutableSpec
	target.ID = "agentspec-rebuilt"
	target.Revision = base.NextSpecRevision
	agent := base.Agent
	agent.AgentSpecRevisionID = target.ID
	agent.ExecutionRevisionID = "execution-rebuilt"
	agent.LastSuccessfulExecutionRevisionID = "execution-rebuilt"
	return ports.AgentRebuildState{
		Agent: agent, SourceSpec: base.ExecutableSpec,
		SourceExecution: base.ExecutableExecution, TargetSpec: target,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-agent", RequestFingerprint: "fingerprint",
			AgentID: agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
			SourceSpecRevisionID:      base.ExecutableSpec.ID,
			SourceExecutionRevisionID: base.ExecutableExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      target.ID,
		},
	}
}
