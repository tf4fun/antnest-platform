package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ObservedLifecycleStore struct {
	next   ports.LifecycleStore
	logger *slog.Logger
}

func ObserveLifecycleStore(
	next ports.LifecycleStore, logger *slog.Logger,
) (*ObservedLifecycleStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("lifecycle store and logger are required")
	}
	return &ObservedLifecycleStore{next: next, logger: logger}, nil
}

func (store *ObservedLifecycleStore) ReplayAgentCreate(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentCreateState, bool, error) {
	return observeLifecycleReplay(ctx, store, "replay_agent_create", func(callCtx context.Context) (ports.AgentCreateState, bool, error) {
		return store.next.ReplayAgentCreate(callCtx, requestID, fingerprint)
	})
}

func (store *ObservedLifecycleStore) BeginAgentCreate(
	ctx context.Context, input ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	return observeLifecycleReplay(ctx, store, "begin_agent_create", func(callCtx context.Context) (ports.AgentCreateState, bool, error) {
		return store.next.BeginAgentCreate(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) RecordCreateNetwork(
	ctx context.Context,
	requestID string,
	fingerprint string,
	attachment ports.NetworkAttachment,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "record_create_network", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.RecordCreateNetwork(
			callCtx, requestID, fingerprint, attachment, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) RecordCreateRuntime(
	ctx context.Context,
	requestID string,
	fingerprint string,
	runtime ports.RuntimeOperation,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "record_create_runtime", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.RecordCreateRuntime(
			callCtx, requestID, fingerprint, runtime, nextChildRequestID, now,
		)
	})
}

func (store *ObservedLifecycleStore) PublishAgentCreate(
	ctx context.Context, input ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "publish_agent_create", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.PublishAgentCreate(callCtx, input)
	})
}

func (store *ObservedLifecycleStore) FailAgentCreate(
	ctx context.Context, input ports.FailAgentCreate,
) (ports.AgentCreateState, error) {
	return observeLifecycleValue(ctx, store, "fail_agent_create", func(callCtx context.Context) (ports.AgentCreateState, error) {
		return store.next.FailAgentCreate(callCtx, input)
	})
}

func observeLifecycleValue[T any](
	ctx context.Context,
	store *ObservedLifecycleStore,
	operation string,
	call func(context.Context) (T, error),
) (value T, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func observeLifecycleReplay[T any](
	ctx context.Context,
	store *ObservedLifecycleStore,
	operation string,
	call func(context.Context) (T, bool, error),
) (value T, replayed bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func (store *ObservedLifecycleStore) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	result := "success"
	if err != nil {
		result = "error"
		errorClass := catalogStoreErrorClass(err)
		span.SetStatus(codes.Error, errorClass)
		store.logger.ErrorContext(ctx, "Agent Controller repository operation failed",
			"operation", operation, "error_class", errorClass,
		)
	}
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", "postgresql"),
		attribute.String("antnest.repository.operation", operation),
		attribute.String("antnest.result", result),
	}
	span.SetAttributes(attributes...)
	span.End()
	repositoryCalls.Add(ctx, 1, metric.WithAttributes(attributes...))
	repositoryDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
}

var _ ports.LifecycleStore = (*ObservedLifecycleStore)(nil)
