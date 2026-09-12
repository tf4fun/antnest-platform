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

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func Open(ctx context.Context, address string, logger *slog.Logger) (client.Client, error) {
	instrumentation, err := temporalotel.NewTracingInterceptor(temporalotel.TracerOptions{})
	if err != nil {
		return nil, fmt.Errorf("configure workflow tracing: %w", err)
	}
	return client.DialContext(ctx, client.Options{
		HostPort: address, Namespace: "antnest",
		Logger:       temporallog.NewStructuredLogger(logger),
		Interceptors: []interceptor.ClientInterceptor{instrumentation},
	})
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
