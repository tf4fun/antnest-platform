package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/diagnostics"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
)

var (
	repositoryTracer   = otel.Tracer(instrumentationName + "/repository")
	repositoryMeter    = otel.Meter(instrumentationName + "/repository")
	repositoryCalls    = mustCounter(repositoryMeter.Int64Counter("runtime.repository.operations"))
	repositoryDuration = mustHistogram(repositoryMeter.Float64Histogram(
		"runtime.repository.operation.duration", metric.WithUnit("s"),
	))
)

type ObservedRepository struct {
	next           repository.Store
	locker         repository.MutationLocker
	coordinator    repository.ObservationCoordinator
	notifications  repository.ObservationNotificationSource
	logger         *slog.Logger
	databaseSystem string
}

func ObserveRepository(
	next repository.Port, logger *slog.Logger, databaseSystem string,
) (*ObservedRepository, error) {
	if next == nil || logger == nil || databaseSystem == "" {
		return nil, fmt.Errorf("repository port, logger, and database system are required")
	}
	return &ObservedRepository{
		next: next, locker: next, coordinator: next,
		notifications: next, logger: logger, databaseSystem: databaseSystem,
	}, nil
}

func (r *ObservedRepository) WithAgentLock(
	ctx context.Context, agentID string, execute func(context.Context) error,
) (resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "agent_mutation_lock")
	span.SetAttributes(attribute.String("antnest.agent.id", agentID))
	defer func() { r.finish(ctx, span, started, "agent_mutation_lock", resultErr) }()
	return r.locker.WithAgentLock(ctx, agentID, execute)
}

func (r *ObservedRepository) TryAcquireObservationLeadership(
	ctx context.Context,
) (leadership repository.Leadership, acquired bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "observation_leadership")
	defer func() { r.finish(ctx, span, started, "observation_leadership", resultErr) }()
	return r.coordinator.TryAcquireObservationLeadership(ctx)
}

func (r *ObservedRepository) ObservationMonitorReady(ctx context.Context) (ready bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "observation_monitor_ready")
	defer func() { r.finish(ctx, span, started, "observation_monitor_ready", resultErr) }()
	return r.coordinator.ObservationMonitorReady(ctx)
}

func (r *ObservedRepository) ListenObservationNotifications(
	ctx context.Context, ready func(), notify func(string),
) (resultErr error) {
	started := time.Now()
	resultErr = r.notifications.ListenObservationNotifications(ctx, ready, notify)
	r.finishSession(ctx, started, "observation_notifications", resultErr)
	return resultErr
}

func (r *ObservedRepository) BeginTransition(
	ctx context.Context, operation deployment.Operation,
) (stored deployment.Operation, replay bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "begin_transition")
	setOperationAttributes(span, operation)
	defer func() { r.finish(ctx, span, started, "begin_transition", resultErr) }()
	return r.next.BeginTransition(ctx, operation)
}

func (r *ObservedRepository) GenerationClaim(
	ctx context.Context, key deployment.Key,
) (claim repository.GenerationClaim, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "generation_claim")
	setRuntimeAttributes(span, key)
	defer func() { r.finish(ctx, span, started, "generation_claim", resultErr) }()
	return r.next.GenerationClaim(ctx, key)
}

func (r *ObservedRepository) CompleteOperation(
	ctx context.Context,
	operation deployment.Operation,
	observation *deployment.Observation,
) (stored *deployment.Observation, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "complete_operation")
	setOperationAttributes(span, operation)
	defer func() { r.finish(ctx, span, started, "complete_operation", resultErr) }()
	return r.next.CompleteOperation(ctx, operation, observation)
}

func (r *ObservedRepository) GetOperation(
	ctx context.Context, requestID string,
) (operation deployment.Operation, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "get_operation")
	span.SetAttributes(attribute.String("antnest.operation.id", requestID))
	defer func() { r.finish(ctx, span, started, "get_operation", resultErr) }()
	return r.next.GetOperation(ctx, requestID)
}

func (r *ObservedRepository) GetEnvironment(
	ctx context.Context, agentID string,
) (environment deployment.Environment, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "get_environment")
	span.SetAttributes(attribute.String("antnest.agent.id", agentID))
	defer func() { r.finish(ctx, span, started, "get_environment", resultErr) }()
	return r.next.GetEnvironment(ctx, agentID)
}

func (r *ObservedRepository) ListEnvironments(
	ctx context.Context,
) (environments []deployment.Environment, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "list_environments")
	defer func() { r.finish(ctx, span, started, "list_environments", resultErr) }()
	return r.next.ListEnvironments(ctx)
}

func (r *ObservedRepository) AppendObservation(
	ctx context.Context, value deployment.Observation,
) (stored deployment.Observation, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "append_observation")
	setObservationAttributes(span, value)
	defer func() { r.finish(ctx, span, started, "append_observation", resultErr) }()
	return r.next.AppendObservation(ctx, value)
}

func (r *ObservedRepository) ListObservations(
	ctx context.Context, after uint64, limit int,
) (window deployment.ObservationWindow, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "list_observations")
	span.SetAttributes(attribute.Int("antnest.page.limit", limit))
	defer func() { r.finish(ctx, span, started, "list_observations", resultErr) }()
	return r.next.ListObservations(ctx, after, limit)
}

func (r *ObservedRepository) Ready(ctx context.Context) (resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "ready")
	defer func() { r.finish(ctx, span, started, "ready", resultErr) }()
	return r.next.Ready(ctx)
}

func startRepositorySpan(ctx context.Context, operation string) (context.Context, trace.Span, time.Time) {
	ctx, span := repositoryTracer.Start(ctx, "runtime.repository."+operation, trace.WithSpanKind(trace.SpanKindClient))
	return ctx, span, time.Now()
}

func (r *ObservedRepository) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	result := effectResult(err)
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", r.databaseSystem),
		attribute.String("antnest.repository.operation", operation),
		attribute.String("antnest.result", result),
	}
	span.SetAttributes(attributes...)
	if err != nil {
		errorClass := repositoryErrorClass(err)
		span.RecordError(diagnostics.Error(err))
		span.SetStatus(codes.Error, result)
		r.logger.ErrorContext(ctx, "Runtime Controller repository operation failed",
			"operation", operation, "error_class", errorClass, "error", diagnostics.Message(err))
	}
	span.End()
	repositoryCalls.Add(ctx, 1, metric.WithAttributes(attributes...))
	repositoryDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
}

func (r *ObservedRepository) finishSession(
	ctx context.Context, started time.Time, operation string, err error,
) {
	result := sessionResult(err)
	if result == "error" {
		r.logger.ErrorContext(ctx, "Runtime Controller repository session failed",
			"operation", operation, "error_class", repositoryErrorClass(err),
			"error", diagnostics.Message(err))
	}
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", r.databaseSystem),
		attribute.String("antnest.repository.operation", operation),
		attribute.String("antnest.result", result),
	}
	metricCtx := context.WithoutCancel(ctx)
	repositoryCalls.Add(metricCtx, 1, metric.WithAttributes(attributes...))
	repositoryDuration.Record(
		metricCtx, time.Since(started).Seconds(), metric.WithAttributes(attributes...),
	)
}

func repositoryErrorClass(err error) string {
	switch {
	case errors.Is(err, deployment.ErrIdentityConflict):
		return "identity_conflict"
	case errors.Is(err, repository.ErrOperationFinalized):
		return "operation_finalized"
	case errors.Is(err, repository.ErrLockLost):
		return "mutation_lock_lost"
	case errors.Is(err, repository.ErrConcurrentMutation):
		return "agent_mutation_in_progress"
	case errors.Is(err, repository.ErrTransitionConflict):
		return "runtime_lifecycle_conflict"
	case errors.Is(err, repository.ErrRevisionConflict):
		return "runtime_revision_conflict"
	case errors.Is(err, repository.ErrInvariantConflict):
		return "runtime_drift"
	case errors.Is(err, repository.ErrNotFound):
		return "not_found"
	default:
		return "persistence_error"
	}
}

func setOperationAttributes(span trace.Span, operation deployment.Operation) {
	span.SetAttributes(
		attribute.String("antnest.operation.id", operation.RequestID),
		attribute.String("antnest.operation.kind", string(operation.Kind)),
		attribute.String("antnest.agent.id", operation.AgentID),
		attribute.Int64("antnest.runtime.generation", int64(operation.Generation)),
	)
}

func setObservationAttributes(span trace.Span, value deployment.Observation) {
	span.SetAttributes(
		attribute.String("antnest.observation.kind", string(value.Kind)),
		attribute.String("antnest.agent.id", value.AgentID),
		attribute.Int64("antnest.runtime.generation", int64(value.Generation)),
	)
}

var _ repository.Port = (*ObservedRepository)(nil)
