package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const identityRevocationPageSize = 100

type identityDisableScheduler interface {
	DisableAgent(context.Context, DisableAgentInput) (DisableAgentResult, error)
}

type IdentityRevocationWorker struct {
	source       ports.IdentityRevocationSource
	store        ports.IdentityRevocationStore
	scheduler    identityDisableScheduler
	pollInterval time.Duration
	logger       *slog.Logger
	tracer       trace.Tracer
	afterAgentID string
}

func NewIdentityRevocationWorker(source ports.IdentityRevocationSource, store ports.IdentityRevocationStore,
	scheduler identityDisableScheduler, interval time.Duration, logger *slog.Logger) (*IdentityRevocationWorker, error) {
	if source == nil || store == nil || scheduler == nil || interval <= 0 {
		return nil, fmt.Errorf("identity offboarding dependencies are incomplete")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &IdentityRevocationWorker{source: source, store: store, scheduler: scheduler, pollInterval: interval, logger: logger,
		tracer: otel.Tracer("soft/antnest-platform/agent-controller/identity-offboarding")}, nil
}

func (worker *IdentityRevocationWorker) Run(ctx context.Context) {
	ticker := time.NewTicker(worker.pollInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			worker.logger.WarnContext(ctx, "Identity offboarding synchronization failed", "component", "identity_offboarding", "error_class", "identity_offboarding_sync_failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (worker *IdentityRevocationWorker) RunOnce(ctx context.Context) error {
	// Receipt and execution are independent: an Identity outage must not starve
	// durable local offboarding. Each pass is bounded, including failure retries.
	receiptErr := worker.receive(ctx)
	convergeErr := worker.converge(ctx)
	return errors.Join(receiptErr, convergeErr)
}

func (worker *IdentityRevocationWorker) receive(ctx context.Context) error {
	cursor, err := worker.store.GetIdentityRevocationCursor(ctx)
	if err != nil {
		return fmt.Errorf("read Identity receipt cursor: %w", err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	page, err := worker.source.ListPrincipalRevocations(readCtx, cursor, identityRevocationPageSize)
	cancel()
	if err != nil {
		return fmt.Errorf("read Identity revocations: %w", err)
	}
	for _, event := range page.Events {
		if err := worker.receiveOne(ctx, cursor, event); err != nil {
			return err
		}
		cursor = event.Sequence
	}
	return nil
}

func (worker *IdentityRevocationWorker) receiveOne(ctx context.Context, cursor int64, event ports.PrincipalRevocation) error {
	ctx = identityCausalContext(ctx, event.TraceParent)
	ctx, span := worker.tracer.Start(ctx, "agent_controller.identity_offboarding.receive",
		trace.WithSpanKind(trace.SpanKindConsumer), trace.WithAttributes(attribute.Int64("identity.revocation.sequence", event.Sequence)))
	defer span.End()
	if err := worker.store.ApplyIdentityRevocation(ctx, cursor, event, currentTraceID(ctx)); err != nil {
		span.SetStatus(codes.Error, "identity_receipt_failed")
		return fmt.Errorf("persist Identity revocation: %w", err)
	}
	return nil
}

func (worker *IdentityRevocationWorker) converge(ctx context.Context) error {
	pending, err := worker.store.ListPendingOwnerRevocations(ctx, worker.afterAgentID, identityRevocationPageSize)
	if err != nil {
		return fmt.Errorf("read pending owner revocations: %w", err)
	}
	var result error
	for _, item := range pending {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		worker.afterAgentID = item.AgentID
		result = errors.Join(result, worker.schedule(ctx, item))
	}
	if len(pending) < identityRevocationPageSize {
		worker.afterAgentID = ""
	}
	return result
}

func (worker *IdentityRevocationWorker) schedule(ctx context.Context, item ports.PendingOwnerRevocation) error {
	ctx = identityCausalContext(ctx, item.TraceParent)
	ctx, span := worker.tracer.Start(ctx, "agent_controller.identity_offboarding.disable",
		trace.WithSpanKind(trace.SpanKindConsumer), trace.WithAttributes(attribute.String("agent.id", item.AgentID), attribute.Int64("identity.revocation.sequence", item.Sequence)))
	defer span.End()
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := worker.scheduler.DisableAgent(callCtx, DisableAgentInput{
		RequestID: derivedID("owner-disable", fmt.Sprintf("%s:%d:%d", item.AgentID, item.Sequence, item.AggregateSequence)),
		AgentID:   item.AgentID, OwnerRevocationSequence: item.Sequence,
	})
	if errors.Is(err, ErrAgentNotReady) || errors.Is(err, ErrLifecycleConflict) || errors.Is(err, ports.ErrConcurrentChange) || errors.Is(err, ErrAgentNotFound) {
		span.SetAttributes(attribute.String("antnest.result", "pending"))
		return nil
	}
	if err != nil {
		span.SetStatus(codes.Error, "identity_disable_schedule_failed")
	}
	return err
}

func identityCausalContext(ctx context.Context, parent string) context.Context {
	ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
	return propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{"traceparent": parent})
}
