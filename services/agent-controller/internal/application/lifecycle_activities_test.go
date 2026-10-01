package application

import (
	"context"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"slices"
	"testing"
	"time"
)

func readyActivityRuntime(suffix string) ports.RuntimeOperation {
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_22222222222222222222222222222222",
		RuntimeExecutionID: "",
		MCPEndpoint:        "",
		LifecycleState:     "provisioned", Health: "unknown",
	}
}
func TestCreateLifecycleActivitiesAdvancesOneDurablePhasePerActivity(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
	}
	service := newLifecycleTestService(t, store, dependencies)
	result, err := service.CreateAgent(
		context.Background(), lifecycleCreateInput("request-recovery-create"),
	)
	if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("start recoverable create: result=%+v err=%v", result, err)
	}
	store.replayed = true
	dependencies.runtime = readyActivityRuntime("created")
	dependencies.networkIndex = 0
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseRuntimeInitialize, domain.OperationRunning, false, []string{"egress.ensure"}},
		{domain.PhasePublish, domain.OperationRunning, false, []string{"runtime.initialize"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, []string{"egress.attachment.open"}},
	}
	assertLifecycleActivitiesPlan(t, domain.OperationCreate, steps)
	for _, step := range steps {
		resumeLifecycleActivitiesStep(
			t, service, &store.beginState.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestRebuildLifecycleActivitiesAdvancesOneDurablePhasePerActivity(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := &rebuildDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{State: "running"},
	}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := service.RebuildAgent(
		context.Background(),
		RebuildAgentInput{
			RequestID: "request-recovery-rebuild", AgentID: base.Agent.AgentID,
			TemplateID: "template-1", TemplateRevision: 1,
		},
	)
	if err != nil {
		t.Fatalf("start recoverable rebuild: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted rebuild = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = readyActivityRuntime("rebuilt")
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeUpdate, domain.OperationRunning, false,
			[]string{"egress.get", "egress.attachment.closed"}},
		{domain.PhaseNetworkEnsure, domain.OperationRunning, false,
			[]string{"runtime.update"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.attachment.open"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleActivitiesPlan(t, domain.OperationRebuild, steps)
	for _, step := range steps {
		resumeLifecycleActivitiesStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestDisableLifecycleActivitiesAdvancesOneDurablePhasePerActivity(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.DisableAgent(
		context.Background(),
		DisableAgentInput{RequestID: "request-recovery-disable", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable disable: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted disable = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
		LifecycleState: "disabled", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeDisable, domain.OperationRunning, false,
			[]string{"egress.get", "egress.attachment.closed"}},
		{domain.PhasePublish, domain.OperationRunning, false, []string{"runtime.disable"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleActivitiesPlan(t, domain.OperationDisable, steps)
	for _, step := range steps {
		resumeLifecycleActivitiesStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestEnableLifecycleActivitiesAdvancesOneDurablePhasePerActivity(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(
		context.Background(),
		EnableAgentInput{RequestID: "request-recovery-enable", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable enable: %v", err)
	}
	if result.Operation.Phase != domain.PhaseNetworkEnsure || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted enable = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = readyEnableRuntime()
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseRuntimeEnable, domain.OperationRunning, false,
			[]string{"egress.ensure"}},
		{domain.PhaseNetworkRestore, domain.OperationRunning, false, []string{"runtime.enable"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.attachment.open"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleActivitiesPlan(t, domain.OperationEnable, steps)
	for _, step := range steps {
		resumeLifecycleActivitiesStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestDeleteLifecycleActivitiesAdvancesOneDurablePhasePerActivity(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.RuntimeAvailable)
	store := &deleteLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.runtime = ports.RuntimeOperation{State: "running"}
	service := newTestLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(700, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := service.DeleteAgent(
		context.Background(),
		DeleteAgentInput{RequestID: "request-recovery-delete", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable delete: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted delete = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_99999999999999999999999999999999",
		LifecycleState:  "deleted", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeDelete, domain.OperationRunning, false,
			[]string{"egress.network.get", "egress.attachment.closed"}},
		{domain.PhaseNetworkRelease, domain.OperationRunning, false, []string{"runtime.delete"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.network.get", "egress.release"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleActivitiesPlan(t, domain.OperationDelete, steps)
	for _, step := range steps {
		resumeLifecycleActivitiesStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

type lifecycleRecoveryStepExpectation struct {
	phase    domain.OperationPhase
	state    domain.OperationState
	terminal bool
	calls    []string
}

func assertLifecycleActivitiesPlan(
	t *testing.T, kind domain.OperationKind, steps []lifecycleRecoveryStepExpectation,
) {
	t.Helper()
	plan, err := domain.OperationPlan(kind)
	if err != nil {
		t.Fatalf("load %s operation plan: %v", kind, err)
	}
	want := append(slices.Clone(plan[1:]), domain.PhaseCompleted)
	got := make([]domain.OperationPhase, 0, len(steps))
	for _, step := range steps {
		got = append(got, step.phase)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("%s activity phases = %v, want operation plan continuation %v", kind, got, want)
	}
}
func assertPhaseBoundary(
	t *testing.T,
	operation OperationView,
	wantPhase domain.OperationPhase,
	wantState domain.OperationState,
	gotCalls []string,
	wantCalls []string,
) {
	t.Helper()
	if operation.Phase != wantPhase || operation.State != wantState {
		t.Fatalf("operation = %+v, want phase=%s state=%s", operation, wantPhase, wantState)
	}
	if !slices.Equal(gotCalls, wantCalls) {
		t.Fatalf("dependency calls = %v, want %v", gotCalls, wantCalls)
	}
}

func resumeLifecycleActivitiesStep(t *testing.T, service *LifecycleService, operation *ports.LifecycleOperationRecord, dependencyCalls func() []string, wantPhase domain.OperationPhase, wantState domain.OperationState, wantTerminal bool, wantCalls []string) {
	t.Helper()
	before := len(dependencyCalls())
	got, err := advanceRecordForTest(context.Background(), service, *operation)
	if err != nil {
		t.Fatal(err)
	}
	if !wantTerminal && operation.ChildRequestID != domain.ChildRequestID(operation.RequestID, wantPhase) {
		t.Fatalf("incorrect child id: %s", operation.ChildRequestID)
	}
	assertPhaseBoundary(t, got, wantPhase, wantState, dependencyCalls()[before:], wantCalls)
}
func advanceRecordForTest(ctx context.Context, service *LifecycleService, op ports.LifecycleOperationRecord) (OperationView, error) {
	switch op.Kind {
	case domain.OperationCreate:
		state, found, err := service.store.ReplayAgentCreate(ctx, op.RequestID, op.RequestFingerprint)
		if err != nil || !found {
			return OperationView{}, lifecycleReplayError("create", found, err)
		}
		return advanceStage(ctx, op.Kind, lifecycleStage{result: LifecycleResult{Operation: lifecycleOperationView(state.Operation)}, step: func(ctx context.Context) (OperationView, error) {
			next, err := service.stepAgentCreate(ctx, state)
			return lifecycleOperationView(next.Operation), err
		}}, op.Phase)
	case domain.OperationRebuild:
		state, found, err := service.store.ReplayAgentRebuild(ctx, op.RequestID, op.RequestFingerprint)
		if err != nil || !found {
			return OperationView{}, lifecycleReplayError("rebuild", found, err)
		}
		return advanceStage(ctx, op.Kind, lifecycleStage{result: LifecycleResult{Operation: lifecycleOperationView(state.Operation)}, step: func(ctx context.Context) (OperationView, error) {
			next, err := service.stepAgentRebuild(ctx, state)
			return lifecycleOperationView(next.Operation), err
		}}, op.Phase)
	case domain.OperationDisable:
		state, found, err := service.store.ReplayAgentDisable(ctx, op.RequestID, op.RequestFingerprint)
		if err != nil || !found {
			return OperationView{}, lifecycleReplayError("disable", found, err)
		}
		return advanceStage(ctx, op.Kind, lifecycleStage{result: LifecycleResult{Operation: lifecycleOperationView(state.Operation)}, step: func(ctx context.Context) (OperationView, error) {
			next, err := service.stepAgentDisable(ctx, state)
			return lifecycleOperationView(next.Operation), err
		}}, op.Phase)
	case domain.OperationEnable:
		state, found, err := service.store.ReplayAgentEnable(ctx, op.RequestID, op.RequestFingerprint)
		if err != nil || !found {
			return OperationView{}, lifecycleReplayError("enable", found, err)
		}
		return advanceStage(ctx, op.Kind, lifecycleStage{result: LifecycleResult{Operation: lifecycleOperationView(state.Operation)}, step: func(ctx context.Context) (OperationView, error) {
			next, err := service.stepAgentEnable(ctx, state)
			return lifecycleOperationView(next.Operation), err
		}}, op.Phase)
	case domain.OperationDelete:
		state, found, err := service.store.ReplayAgentDelete(ctx, op.RequestID, op.RequestFingerprint)
		if err != nil || !found {
			return OperationView{}, lifecycleReplayError("delete", found, err)
		}
		return advanceStage(ctx, op.Kind, lifecycleStage{result: LifecycleResult{Operation: lifecycleOperationView(state.Operation)}, step: func(ctx context.Context) (OperationView, error) {
			next, err := service.stepAgentDelete(ctx, state)
			return lifecycleOperationView(next.Operation), err
		}}, op.Phase)
	default:
		return OperationView{}, ErrInvalidInput
	}
}
