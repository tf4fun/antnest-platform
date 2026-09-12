package orchestration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestTemporalLifecycleWorkerReplacement(t *testing.T) {
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set")
	}
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationEnable, domain.OperationDelete} {
		t.Run(string(kind), func(t *testing.T) { checkEngineReplacement(t, address, kind) })
	}
}

func checkEngineReplacement(t *testing.T, address string, kind domain.OperationKind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	c, err := Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	queue := fmt.Sprintf("lifecycle-test-%s-%d", kind, time.Now().UnixNano())
	command := application.LifecycleCommand{Kind: kind, RequestID: queue, AgentID: "agent-test"}
	phases, err := domain.OperationPlan(kind)
	if err != nil {
		t.Fatal(err)
	}
	runtimePhase := map[domain.OperationKind]domain.OperationPhase{domain.OperationRebuild: domain.PhaseRuntimeUpdate, domain.OperationDisable: domain.PhaseRuntimeDisable, domain.OperationEnable: domain.PhaseRuntimeEnable, domain.OperationDelete: domain.PhaseRuntimeDelete}[kind]
	var lock sync.Mutex
	calls := make(map[string]int)
	count := func(key string) int { lock.Lock(); defer lock.Unlock(); calls[key]++; return calls[key] }
	entered := make(chan struct{})
	newWorker := func() worker.Worker {
		w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
		w.RegisterWorkflow(LifecycleWorkflow)
		w.RegisterActivityWithOptions(func(context.Context, application.LifecycleCommand) (application.LifecycleResult, error) {
			count("admit")
			return application.LifecycleResult{Agent: application.AgentView{AgentID: "agent-test"}}, nil
		}, activity.RegisterOptions{Name: lifecycleAdmission})
		for _, phase := range phases {
			w.RegisterActivityWithOptions(func(ctx context.Context, _ application.LifecycleCommand) (application.OperationView, error) {
				ctx, stop := activityLifetime(ctx)
				defer stop()
				attempt := count(string(phase))
				if phase == runtimePhase && attempt == 1 {
					close(entered)
					<-ctx.Done()
					return application.OperationView{}, ctx.Err()
				}
				return application.OperationView{State: domain.OperationCompleted}, nil
			}, activity.RegisterOptions{Name: lifecycleActivity(phase)})
		}
		return w
	}
	first := newWorker()
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			first.Stop()
		}
	}()
	caller, stopCaller := context.WithCancel(ctx)
	defer stopCaller()
	run, err := c.ExecuteWorkflow(caller, client.StartWorkflowOptions{ID: queue, TaskQueue: queue}, LifecycleWorkflow, command)
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	defer func() {
		if !finished {
			cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if err := c.TerminateWorkflow(cleanup, queue, run.GetRunID(), "failed test cleanup"); err != nil {
				t.Errorf("cleanup workflow: %v", err)
			}
		}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	stopCaller()
	first.Stop()
	stopped = true
	second := newWorker()
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if err := run.Get(ctx, nil); err != nil {
		t.Fatal(err)
	}
	finished = true
	lock.Lock()
	defer lock.Unlock()
	if calls["admit"] != 1 {
		t.Fatalf("admission replayed: %v", calls)
	}
	for _, phase := range phases {
		want := 1
		if phase == runtimePhase {
			want = 2
		}
		if calls[string(phase)] != want {
			t.Fatalf("activity counts: %v", calls)
		}
	}
}
