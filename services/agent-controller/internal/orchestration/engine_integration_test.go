package orchestration

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"

	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestTemporalCreationSurvivesWorkerReplacement(t *testing.T) {
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	c, err := Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	queue := fmt.Sprintf("creation-test-%d", time.Now().UnixNano())
	command := testCommand()
	command.RequestID = queue
	var admissions, networks, runtimes, publications atomic.Int32
	firstRuntime := make(chan struct{})
	newWorker := func() worker.Worker {
		w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
		w.RegisterWorkflow(CreateAgentWorkflow)
		w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
			admissions.Add(1)
			return testAdmission(), nil
		}, activity.RegisterOptions{Name: AdmitActivity})
		w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			networks.Add(1)
			return application.OperationView{State: domain.OperationRunning}, nil
		}, activity.RegisterOptions{Name: string(domain.PhaseNetworkEnsure)})
		w.RegisterActivityWithOptions(func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
			if runtimes.Add(1) == 1 {
				close(firstRuntime)
				select {
				case <-activity.GetWorkerStopChannel(ctx):
					return application.OperationView{}, errors.New("worker replaced during dependency call")
				case <-ctx.Done():
					return application.OperationView{}, ctx.Err()
				}
			}
			return application.OperationView{State: domain.OperationRunning}, nil
		}, activity.RegisterOptions{Name: string(domain.PhaseRuntimeInitialize)})
		w.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			publications.Add(1)
			return application.OperationView{State: domain.OperationCompleted}, nil
		}, activity.RegisterOptions{Name: string(domain.PhasePublish)})
		return w
	}
	first := newWorker()
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	firstStopped := false
	defer func() {
		if !firstStopped {
			first.Stop()
		}
	}()
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		state, describeErr := c.DescribeWorkflowExecution(cleanup, queue, "")
		var missing *serviceerror.NotFound
		if errors.As(describeErr, &missing) {
			return
		}
		if describeErr != nil {
			t.Errorf("inspect test workflow cleanup: %v", describeErr)
			return
		}
		if state.WorkflowExecutionInfo.Status == enums.WORKFLOW_EXECUTION_STATUS_RUNNING {
			if err := c.TerminateWorkflow(cleanup, queue, "", "test cleanup"); err != nil {
				t.Errorf("terminate unfinished test workflow: %v", err)
			}
		}
	}()
	caller, stopCaller := context.WithCancel(ctx)
	defer stopCaller()
	start := c.NewWithStartWorkflowOperation(client.StartWorkflowOptions{
		ID: queue, TaskQueue: queue, WorkflowIDConflictPolicy: enums.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
	}, CreateAgentWorkflow, command)
	update, err := c.UpdateWithStartWorkflow(caller, client.UpdateWithStartWorkflowOptions{
		StartWorkflowOperation: start,
		UpdateOptions: client.UpdateWorkflowOptions{UpdateID: "admission", UpdateName: admissionUpdate,
			WaitForStage: client.WorkflowUpdateStageCompleted, Args: []interface{}{command}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var admitted application.CreateAgentResult
	if err := update.Get(caller, &admitted); err != nil || admitted.Agent.AgentID != "agent-test" {
		t.Fatalf("admission: %+v %v", admitted, err)
	}
	stopCaller()
	select {
	case <-firstRuntime:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	first.Stop()
	firstStopped = true
	second := newWorker()
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if err := c.GetWorkflow(ctx, queue, "").Get(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if admissions.Load() != 1 || networks.Load() != 1 || runtimes.Load() != 2 || publications.Load() != 1 {
		t.Fatalf("execution counts: admission=%d network=%d runtime=%d publication=%d",
			admissions.Load(), networks.Load(), runtimes.Load(), publications.Load())
	}
}
