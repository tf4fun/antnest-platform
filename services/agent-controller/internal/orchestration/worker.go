package orchestration

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	temporalotel "go.temporal.io/sdk/contrib/opentelemetry"
	"go.temporal.io/sdk/interceptor"
	temporallog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/worker"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

// The returned close function must run after worker Stop and before telemetry
// shutdown, so pending SDK Workflow parents can still be exported.
func Open(ctx context.Context, address string, logger *slog.Logger) (client.Client, func(), error) {
	spans := newWorkflowSpans()
	instrumentation, err := temporalotel.NewTracingInterceptor(temporalotel.TracerOptions{SpanStarter: spans.start})
	if err != nil {
		return nil, nil, fmt.Errorf("configure workflow tracing: %w", err)
	}
	connection, err := client.DialContext(ctx, client.Options{
		HostPort: address, Namespace: "antnest",
		Logger:       temporallog.NewStructuredLogger(logger),
		Interceptors: []interceptor.ClientInterceptor{instrumentation},
	})
	if err != nil {
		spans.shutdown()
		return nil, nil, err
	}
	return connection, func() {
		connection.Close()
		spans.shutdown()
	}, nil
}

func NewWorker(temporalClient client.Client, service *application.LifecycleService, stopTimeout time.Duration) worker.Worker {
	w := worker.New(temporalClient, TaskQueue, worker.Options{
		WorkerStopTimeout:                      stopTimeout,
		MaxConcurrentActivityExecutionSize:     4,
		MaxConcurrentWorkflowTaskExecutionSize: 4,
	})
	Register(w, service)
	return w
}

type Registry interface {
	RegisterWorkflow(interface{})
	RegisterActivityWithOptions(interface{}, activity.RegisterOptions)
}

func Register(registry Registry, service *application.LifecycleService) {
	registerLifecycle(registry, service)
	registry.RegisterWorkflow(CreateAgentWorkflow)
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.CreateAgentInput) (application.CreateAgentResult, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		result, err := service.CreateAgent(ctx, input)
		return result, activityError(err)
	}, activity.RegisterOptions{Name: AdmitActivity})
	for _, phase := range createPhases {
		registry.RegisterActivityWithOptions(func(ctx context.Context, input application.CreateAgentInput) (application.OperationView, error) {
			ctx, stop := activityLifetime(ctx)
			defer stop()
			result, err := service.AdvanceAgentCreate(ctx, input, phase)
			return result, activityError(err)
		}, activity.RegisterOptions{Name: string(phase)})
	}
}

// Heartbeats and shutdown cancellation belong to the SDK adapter, not domain stages.
func activityLifetime(ctx context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-activity.GetWorkerStopChannel(ctx):
				cancel()
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx)
			}
		}
	}()
	return ctx, func() { cancel(); <-stopped }
}
