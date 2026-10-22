package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/worker"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/orchestration"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// These tests deliberately share the production task queue and run serially in
// the isolated Temporal/PG dependency fixture. Only RC/Egress/ACP are simulated.
func TestRuntimeBarrierRecoveryEnsureStartEngineExecutesOriginalWithoutAdmissionUpdate(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	registry := &runtimeBarrierRecoveryEngineRegistry{
		Worker: worker.New(fixture.engine, orchestration.TaskQueue, worker.Options{WorkerStopTimeout: time.Second}),
		fenced: make(chan struct{}), release: make(chan struct{}),
	}
	orchestration.Register(registry, fixture.lifecycle)
	fixture.worker = registry.Worker
	fixture.release = registry.releaseHeld
	require.NoError(t, registry.Start())
	fixture.workerStarted = true

	require.NoError(t, fixture.service.EnsureRuntimeBarrierRecoveryStarted(fixture.ctx, fixture.receipt))
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, registry.fenced, "the real network-fence activity did not commit")
	runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
	operation, err := fixture.seed.store.GetLifecycleOperation(fixture.ctx, fixture.receipt.Command.RequestID)
	require.NoError(t, err)
	require.Equal(t, domain.PhaseRuntimeUpdate, operation.Phase, "the registered activities must advance the real PG lifecycle")
	registry.mu.Lock()
	admissions := append([]application.LifecycleCommand(nil), registry.admissions...)
	fences := append([]application.LifecycleCommand(nil), registry.fences...)
	registry.mu.Unlock()
	require.Equal(t, []application.LifecycleCommand{fixture.command}, admissions)
	require.Equal(t, []application.LifecycleCommand{fixture.command}, fences)
	assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)

	require.NoError(t, fixture.service.EnsureRuntimeBarrierRecoveryStarted(fixture.ctx, fixture.receipt))
	againRunID, againStatus := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, runID, againRunID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, againStatus)
	runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, fixture.command)
	registry.releaseHeld()
	require.NoError(t, fixture.engine.GetWorkflow(fixture.ctx, fixture.workflowID, runID).Get(fixture.ctx, nil))
	fixture.stopWorker()

	completed, err := fixture.seed.store.GetLifecycleOperation(fixture.ctx, fixture.receipt.Command.RequestID)
	require.NoError(t, err)
	require.Equal(t, domain.OperationCompleted, completed.State)
	require.Equal(t, domain.PhaseCompleted, completed.Phase)
	require.Equal(t, 1, fixture.dependencies.updateCalls, "the existing Runtime boundary is invoked once")
	require.Equal(t, fixture.counts, readRuntimeBarrierAdmissionCounts(t, fixture.ctx, fixture.seed.store, fixture.seed.base.Agent.AgentID))
	require.Equal(t, fixture.receipt, runtimeBarrierAdmissionReceipt(t, fixture.ctx, fixture.seed.store, fixture.seed.begin))
	beforeClosedEnsure := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	require.NoError(t, fixture.service.EnsureRuntimeBarrierRecoveryStarted(fixture.ctx, fixture.receipt))
	closedRunID, closedStatus := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, runID, closedRunID, "closed duplicate starts cannot create another run")
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_COMPLETED, closedStatus)
	history := runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, fixture.command)
	require.Equal(t, 1, history["admit_lifecycle"])
	require.Equal(t, 1, history["lifecycle.network_fence"])
	require.Equal(t, 1, history["lifecycle.runtime_update"])
	require.Equal(t, 1, history["lifecycle.publish"])
	assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)
	require.Equal(t, beforeClosedEnsure, runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store))
	require.Equal(t, 3, fixture.observed.executeCount())
	require.Equal(t, 0, fixture.observed.updateCount())
}

func TestRuntimeBarrierRecoveryEnsureStartEngineRejectsRunningAndClosedDifferentOriginalInput(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	foreign := fixture.command
	foreign.TemplateRevision++
	// No worker is started, so the real execution remains running while its
	// immutable original input can be checked independently of admission.
	run, err := fixture.engine.ExecuteWorkflow(fixture.ctx, client.StartWorkflowOptions{
		ID: fixture.workflowID, TaskQueue: orchestration.TaskQueue,
	}, orchestration.LifecycleWorkflow, foreign)
	require.NoError(t, err)
	before := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	for _, closed := range []bool{false, true} {
		if closed {
			require.NoError(t, fixture.engine.TerminateWorkflow(fixture.ctx, fixture.workflowID, run.GetRunID(), "owned mismatch fixture close"))
		}
		err = fixture.service.EnsureRuntimeBarrierRecoveryStarted(fixture.ctx, fixture.receipt)
		require.Error(t, err, "a real execution with different original input cannot establish a matching start")
		runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
		require.Equal(t, run.GetRunID(), runID)
		if closed {
			require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_TERMINATED, status)
		} else {
			require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
		}
		runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, foreign)
		assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)
		require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store))
	}
	require.Equal(t, 2, fixture.observed.executeCount())
	require.Equal(t, 0, fixture.observed.updateCount())
}

func TestRuntimeBarrierRecoveryEnsureStartEngineCancellationJoinsStartAndLeavesPending(t *testing.T) {
	fixture := newRuntimeBarrierRecoveryEngineFixture(t)
	before := runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store)
	caller, cancel := context.WithCancel(fixture.ctx)
	started, cancellationSeen := make(chan struct{}), make(chan struct{})
	release, dependencyReturned, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseHeld := func() { releaseOnce.Do(func() { close(release) }) }
	fixture.observed.afterExecute = func(ctx context.Context, _ client.WorkflowRun) {
		// The original ExecuteWorkflow RPC has already succeeded against the
		// real engine. Hold its adapter return to test the caller's join boundary.
		defer close(dependencyReturned)
		close(started)
		select {
		case <-ctx.Done():
			close(cancellationSeen)
		case <-release:
			return
		}
		<-release
	}
	results := make(chan error, 1)
	t.Cleanup(func() {
		cancel()
		releaseHeld()
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		select {
		case <-joined:
		case <-cleanup.Done():
			t.Error("the owned ensure-start call did not join after releasing its real-client adapter")
		}
	})
	go func() {
		defer close(joined)
		results <- fixture.service.EnsureRuntimeBarrierRecoveryStarted(caller, fixture.receipt)
	}()
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, started, "the real engine start was not acknowledged")
	runID, status := runtimeBarrierRecoveryEngineExecution(t, fixture.ctx, fixture.engine, fixture.workflowID)
	require.Equal(t, enums.WORKFLOW_EXECUTION_STATUS_RUNNING, status)
	cancel()
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, cancellationSeen, "the actual held call did not observe cancellation")
	// This timer observes non-completion only. Positive completion evidence
	// below comes from the actual dependency and owning-call join receipts.
	guard := time.NewTimer(50 * time.Millisecond)
	select {
	case <-joined:
		guard.Stop()
		t.Fatal("ensure-start returned before the actual held client call settled")
	case <-guard.C:
	}
	releaseHeld()
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, dependencyReturned, "the real-client adapter did not settle")
	runtimeBarrierRecoveryEngineAwait(t, fixture.ctx, joined, "ensure-start did not join its dependency")
	require.ErrorIs(t, <-results, context.Canceled)
	runtimeBarrierRecoveryEngineHistory(t, fixture.ctx, fixture.engine, fixture.workflowID, runID, fixture.command)
	assertRuntimeBarrierRecoveryApplicationPending(t, fixture.ctx, fixture.seed.store, fixture.receipt)
	require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, fixture.ctx, fixture.seed.store),
		"caller cancellation cannot acknowledge a pending DB start or alter business state")
	require.Equal(t, 1, fixture.observed.executeCount())
	require.Equal(t, 0, fixture.observed.updateCount())
}

type runtimeBarrierRecoveryEngineFixture struct {
	ctx           context.Context
	seed          runtimeBarrierAdmissionFixture
	receipt       ports.RuntimeBarrierRecoveryReceipt
	command       application.LifecycleCommand
	counts        runtimeBarrierAdmissionCounts
	lifecycle     *application.LifecycleService
	dependencies  *runtimeRebuildDependencies
	engine        client.Client
	observed      *runtimeBarrierRecoveryEngineClient
	service       *orchestration.Service
	workflowID    string
	worker        worker.Worker
	workerStarted bool
	stopOnce      sync.Once
	release       func()
}

func newRuntimeBarrierRecoveryEngineFixture(t *testing.T) *runtimeBarrierRecoveryEngineFixture {
	t.Helper()
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set; real Temporal start is unverified")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	t.Cleanup(cancel)
	seed := runtimeBarrierAdmissionSeed(t, ctx, fmt.Sprintf("ensure-engine-%d", time.Now().UnixNano()), "original-protected-engine-execution")
	dependencies := newRuntimeRebuildDependencies(seed.base.Agent)
	lifecycle, _ := runtimeRebuildServices(t, seed.store, dependencies)
	accepted, err := application.NewRuntimeBarrierRecoveryAdmissionService(lifecycle, seed.store).Admit(ctx, *seed.begin.Recovery)
	require.NoError(t, err)
	require.False(t, accepted.Replayed)
	receipt := runtimeBarrierAdmissionReceipt(t, ctx, seed.store, seed.begin)
	require.Equal(t, receipt, accepted.Receipt)
	engine, closeClient, err := orchestration.Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	var closeOnce sync.Once
	closeOwnedClient := func() { closeOnce.Do(closeClient) }
	t.Cleanup(closeOwnedClient)
	command := receipt.Command
	fixture := &runtimeBarrierRecoveryEngineFixture{
		ctx: ctx, seed: seed, receipt: receipt, lifecycle: lifecycle, dependencies: dependencies, engine: engine,
		workflowID: "agent-rebuild/" + command.RequestID,
		command: application.LifecycleCommand{
			Kind: domain.OperationRebuild, RequestID: command.RequestID, OrganizationID: command.OrganizationID,
			ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID,
			TemplateID: command.TemplateID, TemplateRevision: command.TemplateRevision,
		},
		counts: readRuntimeBarrierAdmissionCounts(t, ctx, seed.store, seed.base.Agent.AgentID),
	}
	fixture.observed = &runtimeBarrierRecoveryEngineClient{Client: engine, workflowID: fixture.workflowID}
	fixture.service = orchestration.NewService(lifecycle, fixture.observed)
	t.Cleanup(func() {
		if fixture.release != nil {
			fixture.release()
		}
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		err := runtimeBarrierRecoveryEngineTerminate(cleanup, engine, fixture.workflowID)
		fixture.stopWorker()
		closeOwnedClient()
		if err != nil {
			t.Errorf("close owned real Temporal execution: %v", err)
		}
	})
	return fixture
}

func (fixture *runtimeBarrierRecoveryEngineFixture) stopWorker() {
	if fixture.workerStarted {
		fixture.stopOnce.Do(fixture.worker.Stop)
	}
}

type runtimeBarrierRecoveryEngineRegistry struct {
	worker.Worker
	mu          sync.Mutex
	admissions  []application.LifecycleCommand
	fences      []application.LifecycleCommand
	fenced      chan struct{}
	release     chan struct{}
	fencedOnce  sync.Once
	releaseOnce sync.Once
}

func (registry *runtimeBarrierRecoveryEngineRegistry) releaseHeld() {
	registry.releaseOnce.Do(func() { close(registry.release) })
}

func (registry *runtimeBarrierRecoveryEngineRegistry) RegisterActivityWithOptions(fn any, options activity.RegisterOptions) {
	switch options.Name {
	case "admit_lifecycle":
		admit := fn.(func(context.Context, application.LifecycleCommand) (application.LifecycleResult, error))
		registry.Worker.RegisterActivityWithOptions(func(ctx context.Context, command application.LifecycleCommand) (application.LifecycleResult, error) {
			registry.mu.Lock()
			registry.admissions = append(registry.admissions, command)
			registry.mu.Unlock()
			return admit(ctx, command)
		}, options)
	case "lifecycle.network_fence":
		advance := fn.(func(context.Context, application.LifecycleCommand) (application.OperationView, error))
		registry.Worker.RegisterActivityWithOptions(func(ctx context.Context, command application.LifecycleCommand) (application.OperationView, error) {
			result, err := advance(ctx, command)
			if err != nil {
				return result, err
			}
			registry.mu.Lock()
			registry.fences = append(registry.fences, command)
			registry.mu.Unlock()
			registry.fencedOnce.Do(func() { close(registry.fenced) })
			heartbeat := time.NewTicker(5 * time.Second)
			defer heartbeat.Stop()
			for {
				select {
				case <-registry.release:
					return result, nil
				case <-ctx.Done():
					return application.OperationView{}, ctx.Err()
				case <-activity.GetWorkerStopChannel(ctx):
					return application.OperationView{}, context.Canceled
				case <-heartbeat.C:
					activity.RecordHeartbeat(ctx)
				}
			}
		}, options)
	default:
		registry.Worker.RegisterActivityWithOptions(fn, options)
	}
}

// Every start reaches the real Temporal client. The wrapper only records calls,
// forbids admission Updates and supplies the explicit cancellation return gate.
type runtimeBarrierRecoveryEngineClient struct {
	client.Client
	workflowID   string
	mu           sync.Mutex
	executions   int
	updates      int
	afterExecute func(context.Context, client.WorkflowRun)
}

func (observed *runtimeBarrierRecoveryEngineClient) ExecuteWorkflow(ctx context.Context, options client.StartWorkflowOptions, workflow any, args ...any) (client.WorkflowRun, error) {
	observed.mu.Lock()
	observed.executions++
	observed.mu.Unlock()
	if options.ID != observed.workflowID {
		return nil, errors.New("refusing an unowned fixture workflow ID")
	}
	run, err := observed.Client.ExecuteWorkflow(ctx, options, workflow, args...)
	if err == nil && observed.afterExecute != nil {
		observed.afterExecute(ctx, run)
	}
	return run, err
}

func (observed *runtimeBarrierRecoveryEngineClient) NewWithStartWorkflowOperation(client.StartWorkflowOptions, any, ...any) client.WithStartWorkflowOperation {
	observed.recordUpdate()
	return nil
}

func (observed *runtimeBarrierRecoveryEngineClient) UpdateWithStartWorkflow(context.Context, client.UpdateWithStartWorkflowOptions) (client.WorkflowUpdateHandle, error) {
	observed.recordUpdate()
	return nil, errors.New("ensure-start must not send an admission Update")
}

func (observed *runtimeBarrierRecoveryEngineClient) GetWorkflowUpdateHandle(client.GetWorkflowUpdateHandleOptions) client.WorkflowUpdateHandle {
	observed.recordUpdate()
	return nil
}

func (observed *runtimeBarrierRecoveryEngineClient) recordUpdate() {
	observed.mu.Lock()
	defer observed.mu.Unlock()
	observed.updates++
}

func (observed *runtimeBarrierRecoveryEngineClient) executeCount() int {
	observed.mu.Lock()
	defer observed.mu.Unlock()
	return observed.executions
}

func (observed *runtimeBarrierRecoveryEngineClient) updateCount() int {
	observed.mu.Lock()
	defer observed.mu.Unlock()
	return observed.updates
}

func runtimeBarrierRecoveryEngineExecution(t *testing.T, ctx context.Context, engine client.Client, workflowID string) (string, enums.WorkflowExecutionStatus) {
	t.Helper()
	description, err := engine.DescribeWorkflowExecution(ctx, workflowID, "")
	require.NoError(t, err)
	require.NotNil(t, description)
	require.NotNil(t, description.WorkflowExecutionInfo)
	require.NotNil(t, description.WorkflowExecutionInfo.Execution)
	require.Equal(t, workflowID, description.WorkflowExecutionInfo.Execution.WorkflowId)
	require.NotEmpty(t, description.WorkflowExecutionInfo.Execution.RunId)
	return description.WorkflowExecutionInfo.Execution.RunId, description.WorkflowExecutionInfo.Status
}

func runtimeBarrierRecoveryEngineHistory(t *testing.T, ctx context.Context, engine client.Client, workflowID, runID string, command application.LifecycleCommand) map[string]int {
	t.Helper()
	history := engine.GetWorkflowHistory(ctx, workflowID, runID, false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	activities := make(map[string]int)
	starts, updates := 0, 0
	for history.HasNext() {
		event, err := history.Next()
		require.NoError(t, err)
		require.NotNil(t, event)
		if strings.Contains(strings.ToLower(event.EventType.String()), "update") {
			updates++
		}
		if started := event.GetWorkflowExecutionStartedEventAttributes(); started != nil {
			starts++
			require.Equal(t, int64(1), event.EventId)
			require.Equal(t, "LifecycleWorkflow", started.GetWorkflowType().GetName())
			require.Equal(t, orchestration.TaskQueue, started.GetTaskQueue().GetName())
			require.Len(t, started.GetInput().GetPayloads(), 1)
			var original application.LifecycleCommand
			require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(started.Input, &original))
			require.Equal(t, command, original, "Temporal retains only the original lifecycle command")
		}
		if scheduled := event.GetActivityTaskScheduledEventAttributes(); scheduled != nil {
			activities[scheduled.GetActivityType().GetName()]++
		}
	}
	require.Equal(t, 1, starts)
	require.Equal(t, 0, updates, "workflow admission and advancement must not depend on an Update")
	return activities
}

func runtimeBarrierRecoveryEngineAwait(t *testing.T, ctx context.Context, receipt <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-receipt:
	case <-ctx.Done():
		t.Fatalf("%s: %v", message, ctx.Err())
	}
}

func runtimeBarrierRecoveryEngineTerminate(ctx context.Context, engine client.Client, workflowID string) error {
	description, err := engine.DescribeWorkflowExecution(ctx, workflowID, "")
	var missing *serviceerror.NotFound
	if errors.As(err, &missing) {
		return nil
	}
	if err != nil {
		return err
	}
	if description == nil || description.WorkflowExecutionInfo == nil || description.WorkflowExecutionInfo.Execution == nil {
		return errors.New("owned workflow cleanup could not establish execution identity")
	}
	if runtimeBarrierRecoveryEngineClosed(description.WorkflowExecutionInfo.Status) {
		return nil
	}
	if description.WorkflowExecutionInfo.Status != enums.WORKFLOW_EXECUTION_STATUS_RUNNING {
		return errors.New("owned workflow cleanup received an unknown execution status")
	}
	runID := description.WorkflowExecutionInfo.Execution.RunId
	terminateErr := engine.TerminateWorkflow(ctx, workflowID, runID, "owned recovery engine fixture cleanup")
	if terminateErr != nil && !errors.As(terminateErr, &missing) {
		return terminateErr
	}
	closed, err := engine.DescribeWorkflowExecution(ctx, workflowID, runID)
	if err != nil {
		return errors.Join(terminateErr, err)
	}
	if closed == nil || closed.WorkflowExecutionInfo == nil || !runtimeBarrierRecoveryEngineClosed(closed.WorkflowExecutionInfo.Status) {
		return errors.New("owned workflow cleanup did not prove a terminal status")
	}
	return nil
}

func runtimeBarrierRecoveryEngineClosed(status enums.WorkflowExecutionStatus) bool {
	switch status {
	case enums.WORKFLOW_EXECUTION_STATUS_COMPLETED, enums.WORKFLOW_EXECUTION_STATUS_FAILED,
		enums.WORKFLOW_EXECUTION_STATUS_CANCELED, enums.WORKFLOW_EXECUTION_STATUS_TERMINATED,
		enums.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW, enums.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
		return true
	default:
		return false
	}
}
