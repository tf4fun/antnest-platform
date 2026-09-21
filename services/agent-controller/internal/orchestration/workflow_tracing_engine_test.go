package orchestration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestTemporalGracefulReplacementExportsBothOriginalWorkflowParents(t *testing.T) {
	address := os.Getenv("ANTNEST_TEMPORAL_TEST_ADDRESS")
	if address == "" {
		t.Skip("ANTNEST_TEMPORAL_TEST_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(time.Hour)))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	defer func() { require.NoError(t, provider.Shutdown(context.Background())); otel.SetTracerProvider(previous) }()
	caller, root := provider.Tracer("test").Start(ctx, "test admission")
	defer root.End()
	queue := fmt.Sprintf("workflow-parent-test-%d", time.Now().UnixNano())
	var workers []worker.Worker
	var closers []func()
	var cleanupClient client.Client
	finished, started := false, false
	defer func() {
		for _, w := range workers {
			if w != nil {
				w.Stop()
			}
		}
		if started && !finished {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			require.NoError(t, cleanupClient.TerminateWorkflow(cleanup, queue, "", "failed tracing test cleanup"))
		}
		for _, closeClient := range closers {
			closeClient()
		}
	}()
	open := func() (client.Client, func()) {
		c, closeClient, err := Open(ctx, address, slog.New(slog.NewTextHandler(io.Discard, nil)))
		require.NoError(t, err)
		closeOnce := sync.OnceFunc(closeClient)
		closers = append(closers, closeOnce)
		cleanupClient = c
		return c, closeOnce
	}
	var drains atomic.Int32
	entered := make(chan struct{})
	phases, err := domain.OperationPlan(domain.OperationRebuild)
	require.NoError(t, err)
	startWorker := func(c client.Client) worker.Worker {
		w := worker.New(c, queue, worker.Options{WorkerStopTimeout: time.Second})
		w.RegisterWorkflow(LifecycleWorkflow)
		w.RegisterActivityWithOptions(func(context.Context, application.LifecycleCommand) (application.LifecycleResult, error) {
			return application.LifecycleResult{Agent: application.AgentView{AgentID: "agent-test"}}, nil
		}, activity.RegisterOptions{Name: lifecycleAdmission})
		for _, phase := range phases {
			w.RegisterActivityWithOptions(func(ctx context.Context, _ application.LifecycleCommand) (application.OperationView, error) {
				ctx, stop := activityLifetime(ctx)
				defer stop()
				if phase == domain.PhaseDrain && drains.Add(1) == 1 {
					close(entered)
					<-ctx.Done()
					return application.OperationView{}, ctx.Err()
				}
				return application.OperationView{State: domain.OperationCompleted}, nil
			}, activity.RegisterOptions{Name: lifecycleActivity(phase)})
		}
		require.NoError(t, w.Start())
		workers = append(workers, w)
		return w
	}
	first, closeFirst := open()
	firstWorker := startWorker(first)
	run, err := first.ExecuteWorkflow(caller, client.StartWorkflowOptions{ID: queue, TaskQueue: queue}, LifecycleWorkflow,
		application.LifecycleCommand{Kind: domain.OperationRebuild, RequestID: queue, AgentID: "agent-test"})
	require.NoError(t, err)
	started = true
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	firstWorker.Stop()
	workers[0] = nil
	closeFirst()
	require.NoError(t, provider.ForceFlush(ctx))
	var original trace.SpanID
	for _, span := range exporter.GetSpans() {
		if span.Name == "RunWorkflow:LifecycleWorkflow" {
			require.Empty(t, original)
			original = span.SpanContext.SpanID()
			require.Equal(t, "worker_shutdown", spanEndReason(span.Snapshot()))
		}
	}
	require.True(t, original.IsValid(), "original pending Workflow parent was not exported on close")
	second, _ := open()
	startWorker(second)
	require.NoError(t, second.GetWorkflow(ctx, queue, run.GetRunID()).Get(ctx, nil))
	finished = true
	root.End()
	require.Eventually(t, func() bool {
		if provider.ForceFlush(ctx) != nil {
			return false
		}
		count := 0
		for _, span := range exporter.GetSpans() {
			if span.Name == "RunWorkflow:LifecycleWorkflow" {
				count++
			}
		}
		return count == 2
	}, 5*time.Second, 10*time.Millisecond)
	all := exporter.GetSpans()
	ids := map[trace.SpanID]bool{}
	for _, span := range all {
		require.False(t, ids[span.SpanContext.SpanID()], "duplicate exported span")
		ids[span.SpanContext.SpanID()] = true
	}
	reasons := []string{}
	for _, span := range all {
		require.Equal(t, root.SpanContext().TraceID(), span.SpanContext.TraceID())
		if span.Parent.IsValid() {
			require.True(t, ids[span.Parent.SpanID()], "missing actual parent of %s", span.Name)
		}
		if span.Name == "RunWorkflow:LifecycleWorkflow" {
			reasons = append(reasons, spanEndReason(span.Snapshot()))
		}
	}
	require.ElementsMatch(t, []string{"worker_shutdown", "workflow_return"}, reasons)
	require.EqualValues(t, 2, drains.Load())
}
