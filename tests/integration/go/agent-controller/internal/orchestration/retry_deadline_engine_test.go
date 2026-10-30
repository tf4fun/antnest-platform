package orchestration

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestEngineRetryBudgetExhaustionTerminatesPhase(t *testing.T) {
	ctx, c, cleanup := engineClient(t)
	defer cleanup()
	queue := fmt.Sprintf("lifecycle-retry-budget-%d", time.Now().UnixNano())
	command := reliabilityEngineCommand(queue)
	w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
	w.RegisterWorkflowWithOptions(func(ctx workflow.Context, command application.CreateAgentInput) error {
		return createAgentWorkflow(ctx, command, WorkerConfiguration{
			PhaseDeadlines: map[string]time.Duration{"network_ensure": 3 * time.Second},
		})
	}, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
		return testAdmission(), nil
	}, activity.RegisterOptions{Name: AdmitActivity})
	var attempts, terminations, laterPhases atomic.Int32
	w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
		attempts.Add(1)
		return application.OperationView{}, errors.New("temporary dependency unavailable")
	}, activity.RegisterOptions{Name: string(domain.PhaseNetworkEnsure)})
	for _, phase := range createPhases[1:] {
		w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			laterPhases.Add(1)
			return application.OperationView{State: domain.OperationCompleted}, nil
		}, activity.RegisterOptions{Name: string(phase)})
	}
	w.RegisterActivityWithOptions(func(_ context.Context, input application.LifecycleTermination) (application.OperationView, error) {
		terminations.Add(1)
		if input.RequestID != command.RequestID || input.Phase != domain.PhaseNetworkEnsure || input.Code != "phase_deadline_exceeded" {
			return application.OperationView{}, temporal.NewNonRetryableApplicationError("invalid termination", "invalid_test_termination", nil)
		}
		return application.OperationView{RequestID: input.RequestID, State: domain.OperationFailed, ErrorCode: input.Code}, nil
	}, activity.RegisterOptions{Name: terminationActivityName})
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
	err = run.Get(ctx, nil)
	finished = ctx.Err() == nil

	// Confirm this is the real engine's retry-budget outcome, rather than an
	// activity that itself returns TimeoutError or waits for context cancellation.
	iterator := c.GetWorkflowHistory(ctx, workflowID, run.GetRunID(), false, enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	var retryTimeout bool
	for iterator.HasNext() {
		event, historyErr := iterator.Next()
		if historyErr != nil {
			t.Fatal(historyErr)
		}
		if failed := event.GetActivityTaskFailedEventAttributes(); failed != nil && failed.RetryState == enums.RETRY_STATE_TIMEOUT {
			retryTimeout = failed.Failure.GetApplicationFailureInfo() != nil && failed.Failure.GetTimeoutFailureInfo() == nil
		}
	}
	if !retryTimeout || attempts.Load() < 2 {
		t.Fatalf("expected application-error retry exhaustion, retryTimeout=%v attempts=%d", retryTimeout, attempts.Load())
	}
	var failure *temporal.ApplicationError
	if !errors.As(err, &failure) || failure.Type() != "phase_deadline_exceeded" {
		t.Fatalf("retry-budget exhaustion must terminate the phase: %v", err)
	}
	if terminations.Load() != 1 || laterPhases.Load() != 0 {
		t.Fatalf("terminations=%d later phases=%d", terminations.Load(), laterPhases.Load())
	}
	replayRecordedHistory(t, c, run)
}
