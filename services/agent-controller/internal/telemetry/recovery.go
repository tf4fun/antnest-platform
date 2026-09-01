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
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	recoveryMeter  = otel.Meter(instrumentationName + "/lifecycle-recovery")
	recoveryClaims = mustCounter(recoveryMeter.Int64Counter(
		"antnest.agent_controller.lifecycle_recovery.claims",
		metric.WithDescription("Lifecycle recovery claim outcomes"),
	))
	recoveryAttempts = mustCounter(recoveryMeter.Int64Counter(
		"antnest.agent_controller.lifecycle_recovery.attempts",
		metric.WithDescription("Lifecycle recovery attempt outcomes"),
	))
	recoveryDuration = mustHistogram(recoveryMeter.Float64Histogram(
		"antnest.agent_controller.lifecycle_recovery.duration",
		metric.WithDescription("Lifecycle recovery attempt duration"), metric.WithUnit("s"),
	))
	recoveryLeaseLosses = mustCounter(recoveryMeter.Int64Counter(
		"antnest.agent_controller.lifecycle_recovery.lease_losses",
		metric.WithDescription("Lifecycle recovery fencing rejections"),
	))
)

type ObservedLifecycleRecoveryStore struct {
	next   ports.LifecycleRecoveryStore
	logger *slog.Logger
}

func ObserveLifecycleRecoveryStore(
	next ports.LifecycleRecoveryStore, logger *slog.Logger,
) (*ObservedLifecycleRecoveryStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("lifecycle recovery store and logger are required")
	}
	return &ObservedLifecycleRecoveryStore{next: next, logger: logger}, nil
}

func (store *ObservedLifecycleRecoveryStore) ClaimLifecycleRecovery(
	ctx context.Context, input ports.ClaimLifecycleRecovery,
) (claim ports.LifecycleRecoveryClaim, found bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "claim_lifecycle_recovery")
	defer func() {
		result := "claimed"
		switch {
		case resultErr != nil:
			result = "error"
		case !found:
			result = "empty"
		}
		attributes := []attribute.KeyValue{attribute.String("antnest.result", result)}
		span.SetAttributes(attributes...)
		recoveryClaims.Add(ctx, 1, metric.WithAttributes(attributes...))
		finishRepositorySpan(ctx, store.logger, span, started, "claim_lifecycle_recovery", resultErr)
	}()
	return store.next.ClaimLifecycleRecovery(ctx, input)
}

func (store *ObservedLifecycleRecoveryStore) StartLifecycleRecoveryAttempt(
	ctx context.Context, input ports.StartLifecycleRecoveryAttempt,
) (resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "start_lifecycle_recovery_attempt")
	span.SetAttributes(attribute.Int64("antnest.lifecycle.recovery.attempt", input.Attempt))
	defer func() {
		store.finishLeaseOperation(ctx, span, started, "start_lifecycle_recovery_attempt", resultErr)
	}()
	return store.next.StartLifecycleRecoveryAttempt(ctx, input)
}

func (store *ObservedLifecycleRecoveryStore) ReleaseLifecycleRecoveryClaim(
	ctx context.Context, input ports.ReleaseLifecycleRecoveryClaim,
) (resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "release_lifecycle_recovery_claim")
	span.SetAttributes(
		attribute.Int64("antnest.lifecycle.recovery.attempt", input.Attempt),
		attribute.Bool("antnest.lifecycle.recovery.failed", input.Failed),
	)
	defer func() {
		store.finishLeaseOperation(ctx, span, started, "release_lifecycle_recovery_claim", resultErr)
	}()
	return store.next.ReleaseLifecycleRecoveryClaim(ctx, input)
}

func (store *ObservedLifecycleRecoveryStore) finishLeaseOperation(
	ctx context.Context, span trace.Span, started time.Time, operation string, err error,
) {
	if errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
		recoveryLeaseLosses.Add(ctx, 1)
	}
	finishRepositorySpan(ctx, store.logger, span, started, operation, err)
}

func ObserveLifecycleRecoveryAttempt(
	logger *slog.Logger,
) (application.LifecycleRecoveryInstrumentation, error) {
	if logger == nil {
		return nil, fmt.Errorf("lifecycle recovery logger is required")
	}
	return func(
		ctx context.Context,
		claim ports.LifecycleRecoveryClaim,
		resume func(context.Context, string) (application.LifecycleRecoveryResult, error),
	) (result application.LifecycleRecoveryResult, resultErr error) {
		links := lifecycleRecoveryLinks(claim.Operation)
		ctx, span := otel.Tracer(instrumentationName+"/lifecycle-recovery").Start(
			ctx, "recover Agent lifecycle operation", trace.WithNewRoot(), trace.WithLinks(links...),
			trace.WithAttributes(
				attribute.String("antnest.agent.id", claim.Operation.AgentID),
				attribute.String("antnest.lifecycle.request_id", claim.Operation.RequestID),
				attribute.String("antnest.lifecycle.kind", string(claim.Operation.Kind)),
				attribute.String("antnest.lifecycle.phase", string(claim.Operation.Phase)),
				attribute.Int64("antnest.lifecycle.recovery.attempt", claim.Attempt),
			),
		)
		started := time.Now()
		defer func() {
			outcome := lifecycleRecoveryOutcome(result, resultErr)
			attributes := []attribute.KeyValue{
				attribute.String("antnest.lifecycle.kind", string(claim.Operation.Kind)),
				attribute.String("antnest.lifecycle.phase", string(claim.Operation.Phase)),
				attribute.String("antnest.result", outcome),
			}
			span.SetAttributes(
				attribute.String("antnest.lifecycle.recovery.result", outcome),
				attribute.String("antnest.lifecycle.recovery.next_phase", string(result.Phase)),
				attribute.String("antnest.lifecycle.recovery.state", string(result.State)),
				attribute.Bool("antnest.lifecycle.recovery.progressed", result.Progressed),
				attribute.Bool("antnest.lifecycle.recovery.terminal", result.Terminal),
			)
			if resultErr != nil {
				span.RecordError(resultErr)
				span.SetStatus(codes.Error, outcome)
			}
			recoveryAttempts.Add(ctx, 1, metric.WithAttributes(attributes...))
			recoveryDuration.Record(
				ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...),
			)
			logger.InfoContext(
				ctx, "Agent lifecycle recovery attempt completed",
				"agent_id", claim.Operation.AgentID,
				"request_id", claim.Operation.RequestID,
				"operation_kind", claim.Operation.Kind,
				"phase", claim.Operation.Phase,
				"attempt", claim.Attempt,
				"result", outcome,
			)
			span.End()
		}()
		return resume(ctx, formatTraceParent(trace.SpanContextFromContext(ctx)))
	}, nil
}

func lifecycleRecoveryLinks(operation ports.LifecycleOperationRecord) []trace.Link {
	links := make([]trace.Link, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, raw := range []string{
		operation.InitialTraceParent, operation.PreviousRecoveryTraceParent,
	} {
		spanContext, ok := parseTraceParent(raw)
		if !ok {
			continue
		}
		identity := spanContext.TraceID().String() + "/" + spanContext.SpanID().String()
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		links = append(links, trace.Link{SpanContext: spanContext})
	}
	return links
}

func parseTraceParent(value string) (trace.SpanContext, bool) {
	carrier := propagation.MapCarrier{}
	carrier.Set("traceparent", value)
	ctx := propagation.TraceContext{}.Extract(context.Background(), carrier)
	spanContext := trace.SpanContextFromContext(ctx)
	return spanContext, spanContext.IsValid()
}

func formatTraceParent(spanContext trace.SpanContext) string {
	if !spanContext.IsValid() {
		return ""
	}
	return fmt.Sprintf(
		"00-%s-%s-%02x",
		spanContext.TraceID(), spanContext.SpanID(), byte(spanContext.TraceFlags()),
	)
}

func lifecycleRecoveryOutcome(
	result application.LifecycleRecoveryResult, err error,
) string {
	switch {
	case errors.Is(err, ports.ErrLifecycleRecoveryClaimLost):
		return "lease_lost"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, application.ErrDependencyUnavailable):
		return "dependency_unavailable"
	case errors.Is(err, ports.ErrConcurrentChange):
		return "concurrent_change"
	case err != nil:
		return "error"
	case result.Terminal:
		return "terminal"
	case result.Progressed:
		return "progressed"
	default:
		return "waiting"
	}
}

var _ ports.LifecycleRecoveryStore = (*ObservedLifecycleRecoveryStore)(nil)
