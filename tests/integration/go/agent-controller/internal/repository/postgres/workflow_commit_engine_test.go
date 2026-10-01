package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/orchestration"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

func TestTemporalResumesAfterBusinessCommitBeforeActivityAcknowledgement(t *testing.T) {
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set")
	}
	repository, base := identityTestRepository(t)
	deps := &deleteRetryDependencies{offboardingDependencies: &offboardingDependencies{
		network: *closedNetworkAttachment(base.Agent.AgentID),
		runtime: ports.RuntimeOperation{RuntimeRevision: base.Agent.RuntimeRevision, LifecycleState: "provisioned", Health: "healthy"},
	}, calls: make(map[string]int)}
	service := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	c, closeClient, err := orchestration.Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer closeClient()
	queue := fmt.Sprintf("commit-boundary-%d", time.Now().UnixNano())
	first := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
	committed := make(chan struct{})
	orchestration.Register(&interruptAfterCommit{Worker: first, committed: committed}, service)
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	defer first.Stop()
	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: queue, TaskQueue: queue},
		orchestration.LifecycleWorkflow, application.LifecycleCommand{Kind: domain.OperationDelete, RequestID: queue, AgentID: base.Agent.AgentID})
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		if !finished {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := c.TerminateWorkflow(cleanup, queue, run.GetRunID(), "test cleanup"); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
	}()
	select {
	case <-committed:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	operation, err := repository.GetLifecycleOperation(ctx, queue)
	if err != nil || operation.Phase != domain.PhaseNetworkRelease {
		t.Fatalf("commit not durable: %+v %v", operation, err)
	}
	first.Stop()
	second := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
	orchestration.Register(second, service)
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if err := run.Get(ctx, nil); err != nil {
		t.Fatal(err)
	}
	finished = true
	agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.LifecycleState != domain.AgentDeleted || deps.releases != 1 {
		t.Fatalf("resume failed: %+v %v", agent, err)
	}
	if len(deps.calls) != 1 || deps.calls[domain.ChildRequestID(queue, domain.PhaseRuntimeDelete)] != 1 {
		t.Fatalf("Runtime effect repeated: %v", deps.calls)
	}
	var events int
	if err := repository.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.agent_events WHERE agent_id=$1 AND event_type=$2", base.Agent.AgentID, ports.EventAgentDeleted).Scan(&events); err != nil || events != 1 {
		t.Fatalf("duplicate publication events=%d %v", events, err)
	}
}

type interruptAfterCommit struct {
	worker.Worker
	committed chan struct{}
}

func (registry *interruptAfterCommit) RegisterActivityWithOptions(fn any, options activity.RegisterOptions) {
	if options.Name != "lifecycle.runtime_delete" {
		registry.Worker.RegisterActivityWithOptions(fn, options)
		return
	}
	advance := fn.(func(context.Context, application.LifecycleCommand) (application.OperationView, error))
	registry.Worker.RegisterActivityWithOptions(func(ctx context.Context, command application.LifecycleCommand) (application.OperationView, error) {
		result, err := advance(ctx, command)
		if err != nil {
			return result, err
		}
		close(registry.committed)
		select {
		case <-activity.GetWorkerStopChannel(ctx):
		case <-ctx.Done():
		}
		return application.OperationView{}, errors.New("interrupted after database commit before Activity acknowledgement")
	}, options)
}
