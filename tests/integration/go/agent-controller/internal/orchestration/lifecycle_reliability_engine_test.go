package orchestration

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func reliabilityEngineCommand(requestID string) application.CreateAgentInput {
	command := testCommand()
	command.RequestID = requestID
	return command
}

func legacyCreateWorkflowTestImplementation(ctx workflow.Context, command application.CreateAgentInput) error {
	return runLegacyWorkflow[application.CreateAgentInput, application.CreateAgentResult](
		ctx, command, command.RequestID, AdmitActivity, createPhases,
		func(phase domain.OperationPhase) string { return string(phase) })
}

type reliabilityEngineCounters struct {
	admissions, networks, runtimes, publications, terminations atomic.Int32
}

func registerEngineActivityBases(w worker.Worker, counters *reliabilityEngineCounters, blockFirstNetwork chan struct{}) {
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
		counters.admissions.Add(1)
		return testAdmission(), nil
	}, activity.RegisterOptions{Name: AdmitActivity})
	w.RegisterActivityWithOptions(func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		if counters.networks.Add(1) == 1 && blockFirstNetwork != nil {
			close(blockFirstNetwork)
			select {
			case <-activity.GetWorkerStopChannel(ctx):
				return application.OperationView{}, errors.New("worker replaced during dependency call")
			case <-ctx.Done():
				return application.OperationView{}, ctx.Err()
			}
		}
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	}, activity.RegisterOptions{Name: string(domain.PhaseNetworkEnsure)})
	w.RegisterActivityWithOptions(func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		counters.runtimes.Add(1)
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	}, activity.RegisterOptions{Name: string(domain.PhaseRuntimeInitialize)})
	w.RegisterActivityWithOptions(func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		counters.publications.Add(1)
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return application.OperationView{State: domain.OperationCompleted}, nil
		}
	}, activity.RegisterOptions{Name: string(domain.PhasePublish)})
	w.RegisterActivityWithOptions(func(_ context.Context, input application.LifecycleTermination) (application.OperationView, error) {
		counters.terminations.Add(1)
		return application.OperationView{
			RequestID: input.RequestID, Kind: domain.OperationCreate, Phase: input.Phase,
			State: domain.OperationFailed, ErrorCode: input.Code, ErrorDetail: input.Detail,
		}, nil
	}, activity.RegisterOptions{Name: terminationActivityName})
	w.RegisterActivityWithOptions(func(context.Context, application.LifecycleFailure) error {
		return nil
	}, activity.RegisterOptions{Name: quarantineActivity})
}

func newReliabilityEngineWorker(c client.Client, queue string, configuration WorkerConfiguration, counters *reliabilityEngineCounters, blockFirstNetwork chan struct{}, legacy bool) worker.Worker {
	w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
	if legacy {
		w.RegisterWorkflowWithOptions(legacyCreateWorkflowTestImplementation, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	} else {
		w.RegisterWorkflowWithOptions(func(ctx workflow.Context, command application.CreateAgentInput) error {
			return createAgentWorkflow(ctx, command, configuration)
		}, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	}
	registerEngineActivityBases(w, counters, blockFirstNetwork)
	return w
}

func engineClient(t *testing.T) (context.Context, client.Client, func()) {
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	c, closeClient, err := Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	return ctx, c, func() { closeClient(); cancel() }
}

func TestLegacyCreateHistoryResumesAcrossWorkerReplacement(t *testing.T) {
	ctx, c, cleanup := engineClient(t)
	defer cleanup()
	queue := fmt.Sprintf("lifecycle-reliability-legacy-%d", time.Now().UnixNano())
	command := reliabilityEngineCommand(queue)
	counters := &reliabilityEngineCounters{}
	entered := make(chan struct{})
	first := newReliabilityEngineWorker(c, queue, defaultWorkerConfiguration(), counters, entered, true)
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			first.Stop()
		}
	}()
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: "agent-create/" + command.RequestID, TaskQueue: queue,
	}, "CreateAgentWorkflow", command)
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		if !finished {
			cleanupCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if err := c.TerminateWorkflow(cleanupCtx, "agent-create/"+command.RequestID, run.GetRunID(), "failed test cleanup"); err != nil {
				t.Logf("cleanup workflow: %v", err)
			}
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("network phase never entered the first worker")
	}
	first.Stop()
	stopped = true
	second := newReliabilityEngineWorker(c, queue, WorkerConfiguration{
		PhaseDeadlines: map[string]time.Duration{"network_ensure": time.Millisecond, "runtime_initialize": time.Millisecond, "publish": time.Millisecond, "default": time.Millisecond},
	}, counters, nil, false)
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if err := run.Get(ctx, nil); err != nil {
		t.Fatalf("legacy history must replay under the replacement worker: %v", err)
	}
	finished = true
	if counters.admissions.Load() != 1 || counters.networks.Load() < 2 || counters.publications.Load() != 1 {
		t.Fatalf("legacy replay counters admissions=%d networks=%d publications=%d",
			counters.admissions.Load(), counters.networks.Load(), counters.publications.Load())
	}
	if counters.terminations.Load() != 0 {
		t.Fatal("legacy history must not reach the new termination activity")
	}
	replayRecordedHistory(t, c, run)
}

func TestFrozenDeadlineConfigSurvivesWorkerReplacement(t *testing.T) {
	ctx, c, cleanup := engineClient(t)
	defer cleanup()
	queue := fmt.Sprintf("lifecycle-reliability-frozen-%d", time.Now().UnixNano())
	command := reliabilityEngineCommand(queue)
	counters := &reliabilityEngineCounters{}
	entered := make(chan struct{})
	first := newReliabilityEngineWorker(c, queue, WorkerConfiguration{
		PhaseDeadlines: map[string]time.Duration{"network_ensure": 10 * time.Second},
	}, counters, entered, false)
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			first.Stop()
		}
	}()
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: "agent-create/" + command.RequestID, TaskQueue: queue,
	}, "CreateAgentWorkflow", command)
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		if !finished {
			cleanupCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if err := c.TerminateWorkflow(cleanupCtx, "agent-create/"+command.RequestID, run.GetRunID(), "failed test cleanup"); err != nil {
				t.Logf("cleanup workflow: %v", err)
			}
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("network phase never entered the first worker")
	}
	first.Stop()
	stopped = true
	second := newReliabilityEngineWorker(c, queue, WorkerConfiguration{
		PhaseDeadlines: map[string]time.Duration{"network_ensure": time.Millisecond, "runtime_initialize": time.Millisecond, "publish": time.Millisecond, "default": time.Millisecond},
	}, counters, nil, false)
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if err := run.Get(ctx, nil); err != nil {
		t.Fatalf("frozen history must finish under the recorded deadlines: %v", err)
	}
	finished = true
	if counters.admissions.Load() != 1 || counters.networks.Load() < 2 ||
		counters.runtimes.Load() != 1 || counters.publications.Load() != 1 {
		t.Fatalf("frozen replay counters networks=%d runtimes=%d publications=%d",
			counters.networks.Load(), counters.runtimes.Load(), counters.publications.Load())
	}
	if counters.terminations.Load() != 0 {
		t.Fatal("the replacement worker 1ms deadlines must not reach the frozen history")
	}
	replayRecordedHistory(t, c, run)
}

func TestEngineCancelCreateStopsActivityBeforeTermination(t *testing.T) {
	ctx, c, cleanup := engineClient(t)
	defer cleanup()
	queue := fmt.Sprintf("lifecycle-cancel-%d", time.Now().UnixNano())
	command := reliabilityEngineCommand(queue)
	entered := make(chan struct{})
	stopped := make(chan struct{})
	terminateProof := make(chan error, 1)
	childStarted := make(chan string, 1)
	w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
	w.RegisterWorkflowWithOptions(func(ctx workflow.Context, command application.CreateAgentInput) error {
		return createAgentWorkflow(ctx, command, defaultWorkerConfiguration())
	}, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	w.RegisterWorkflowWithOptions(func(_ workflow.Context, child application.LifecycleCommand) error {
		childStarted <- child.RequestID
		return nil
	}, workflow.RegisterOptions{Name: "LifecycleWorkflow"})
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
		return testAdmission(), nil
	}, activity.RegisterOptions{Name: AdmitActivity})
	w.RegisterActivityWithOptions(func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		close(entered)
		lifetimeCtx, stop := activityLifetime(ctx)
		defer stop()
		for {
			select {
			case <-lifetimeCtx.Done():
				close(stopped)
				return application.OperationView{}, lifetimeCtx.Err()
			case <-time.After(50 * time.Millisecond):
				activity.RecordHeartbeat(lifetimeCtx, "working")
			}
		}
	}, activity.RegisterOptions{Name: string(domain.PhaseNetworkEnsure)})
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
		return application.OperationView{State: domain.OperationRunning}, nil
	}, activity.RegisterOptions{Name: string(domain.PhaseRuntimeInitialize)})
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
		return application.OperationView{State: domain.OperationCompleted}, nil
	}, activity.RegisterOptions{Name: string(domain.PhasePublish)})
	w.RegisterActivityWithOptions(func(_ context.Context, input application.LifecycleTermination) (application.OperationView, error) {
		select {
		case <-stopped:
			terminateProof <- nil
		default:
			terminateProof <- errors.New("termination ran before the activity observed cancellation")
		}
		return application.OperationView{
			RequestID: input.RequestID, Kind: domain.OperationCreate, Phase: input.Phase,
			State: domain.OperationFailed, ErrorCode: input.Code, ErrorDetail: input.Detail,
		}, nil
	}, activity.RegisterOptions{Name: terminationActivityName})
	w.RegisterActivityWithOptions(func(context.Context, application.LifecycleFailure) error {
		return nil
	}, activity.RegisterOptions{Name: quarantineActivity})
	if err := w.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	workflowID := "agent-create/" + command.RequestID
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: workflowID, TaskQueue: queue}, "CreateAgentWorkflow", command)
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		if !finished {
			cleanupCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if err := c.TerminateWorkflow(cleanupCtx, workflowID, run.GetRunID(), "failed test cleanup"); err != nil {
				t.Logf("cleanup workflow: %v", err)
			}
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("network phase never started")
	}
	forged, err := c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID: workflowID, UpdateName: "cancel_lifecycle_operation",
		Args: []interface{}{"forged-request"}, WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err == nil {
		var ignored interface{}
		err = forged.Get(ctx, &ignored)
	}
	if err == nil {
		t.Fatal("mismatched request ID must be rejected")
	}
	handle, err := c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID: workflowID, UpdateName: "cancel_lifecycle_operation",
		Args: []interface{}{command.RequestID}, WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err != nil {
		t.Fatalf("cancel update: %v", err)
	}
	var ignored interface{}
	if err := handle.Get(ctx, &ignored); err != nil {
		t.Fatalf("cancel outcome: %v", err)
	}
	err = run.Get(ctx, nil)
	finished = true
	if err == nil || !strings.Contains(err.Error(), "lifecycle_cancelled") {
		t.Fatalf("cancelled create must fail with lifecycle_cancelled: %v", err)
	}
	select {
	case proofErr := <-terminateProof:
		if proofErr != nil {
			t.Fatal(proofErr)
		}
	case <-ctx.Done():
		t.Fatal("termination never ran")
	}
	select {
	case requestID := <-childStarted:
		expected := domain.DeriveResourceID("request", "lifecycle-cancel-delete", command.RequestID)
		if requestID != expected {
			t.Fatalf("child delete request %q, want %q", requestID, expected)
		}
	case <-ctx.Done():
		t.Fatal("deterministic child delete never started")
	}
}

// replayRecordedHistory replays the actual engine-recorded history under the
// current exported workflow implementation — the same path a replacement
// worker takes when resuming an older execution.
func replayRecordedHistory(t *testing.T, c client.Client, run client.WorkflowRun) {
	t.Helper()
	historyCtx, done := context.WithTimeout(t.Context(), 10*time.Second)
	defer done()
	iterator := c.GetWorkflowHistory(historyCtx, run.GetID(), run.GetRunID(),
		false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	history := &historypb.History{}
	for iterator.HasNext() {
		event, err := iterator.Next()
		if err != nil {
			t.Fatalf("collect workflow history: %v", err)
		}
		history.Events = append(history.Events, event)
	}
	if len(history.Events) == 0 {
		t.Fatal("no recorded history to replay")
	}
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(CreateAgentWorkflow, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	if err := replayer.ReplayWorkflowHistory(
		log.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil))), history); err != nil {
		t.Fatalf("recorded history must replay under the current implementation: %v", err)
	}
}
