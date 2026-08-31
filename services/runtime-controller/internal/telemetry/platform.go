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
)

var (
	platformTracer   = otel.Tracer(instrumentationName + "/platform")
	platformMeter    = otel.Meter(instrumentationName + "/platform")
	platformCalls    = mustCounter(platformMeter.Int64Counter("runtime.platform.operations"))
	platformDuration = mustHistogram(platformMeter.Float64Histogram(
		"runtime.platform.operation.duration", metric.WithUnit("s"),
	))
)

type PlatformPort interface {
	Ready(context.Context) error
	DeploymentDigest(deployment.Deployment) (string, error)
	Create(context.Context, deployment.Deployment, string) deployment.EffectOutcome
	Inspect(context.Context, deployment.Key) (deployment.Inspection, error)
	Delete(context.Context, deployment.Key, string) deployment.EffectOutcome
	EnsureStorage(context.Context, string) deployment.EffectOutcome
	VerifyStorage(context.Context, string) deployment.EffectOutcome
	DeleteStorage(context.Context, string) deployment.EffectOutcome
	List(context.Context) ([]deployment.Inspection, error)
	Watch(context.Context, time.Time, func(context.Context, deployment.Observation) error) error
}

type ObservedPlatform struct {
	next     PlatformPort
	logger   *slog.Logger
	platform string
}

func ObservePlatform(next PlatformPort, logger *slog.Logger, platform string) (*ObservedPlatform, error) {
	if next == nil || logger == nil || platform == "" {
		return nil, fmt.Errorf("platform port, logger, and platform name are required")
	}
	return &ObservedPlatform{next: next, logger: logger, platform: platform}, nil
}

func (p *ObservedPlatform) Ready(ctx context.Context) error {
	started := time.Now()
	ctx, span := platformTracer.Start(ctx, "runtime.platform.ready")
	err := p.next.Ready(ctx)
	p.finish(ctx, span, started, "ready", effectResult(err), err)
	return err
}

func (p *ObservedPlatform) DeploymentDigest(value deployment.Deployment) (string, error) {
	return p.next.DeploymentDigest(value)
}

func (p *ObservedPlatform) Create(
	ctx context.Context, value deployment.Deployment, digest string,
) deployment.EffectOutcome {
	key := deployment.Key{AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}
	return p.mutate(ctx, "create", key, func(operationCtx context.Context) deployment.EffectOutcome {
		return p.next.Create(operationCtx, value, digest)
	})
}

func (p *ObservedPlatform) Inspect(
	ctx context.Context, key deployment.Key,
) (deployment.Inspection, error) {
	started := time.Now()
	ctx, span := platformTracer.Start(ctx, "runtime.platform.inspect")
	setRuntimeAttributes(span, key)
	inspection, err := p.next.Inspect(ctx, key)
	p.finish(ctx, span, started, "inspect", effectResult(err), err)
	return inspection, err
}

func (p *ObservedPlatform) Delete(
	ctx context.Context, key deployment.Key, digest string,
) deployment.EffectOutcome {
	return p.mutate(ctx, "delete", key, func(operationCtx context.Context) deployment.EffectOutcome {
		return p.next.Delete(operationCtx, key, digest)
	})
}

func (p *ObservedPlatform) EnsureStorage(
	ctx context.Context, agentID string,
) deployment.EffectOutcome {
	return p.mutate(ctx, "ensure_storage", deployment.Key{AgentID: agentID}, func(operationCtx context.Context) deployment.EffectOutcome {
		return p.next.EnsureStorage(operationCtx, agentID)
	})
}

func (p *ObservedPlatform) VerifyStorage(
	ctx context.Context, agentID string,
) deployment.EffectOutcome {
	return p.mutate(ctx, "verify_storage", deployment.Key{AgentID: agentID}, func(operationCtx context.Context) deployment.EffectOutcome {
		return p.next.VerifyStorage(operationCtx, agentID)
	})
}

func (p *ObservedPlatform) DeleteStorage(
	ctx context.Context, agentID string,
) deployment.EffectOutcome {
	return p.mutate(ctx, "delete_storage", deployment.Key{AgentID: agentID}, func(operationCtx context.Context) deployment.EffectOutcome {
		return p.next.DeleteStorage(operationCtx, agentID)
	})
}

func (p *ObservedPlatform) List(ctx context.Context) ([]deployment.Inspection, error) {
	started := time.Now()
	ctx, span := platformTracer.Start(ctx, "runtime.platform.list")
	values, err := p.next.List(ctx)
	p.finish(ctx, span, started, "list", effectResult(err), err)
	return values, err
}

func (p *ObservedPlatform) Watch(
	ctx context.Context,
	since time.Time,
	emit func(context.Context, deployment.Observation) error,
) error {
	started := time.Now()
	err := p.next.Watch(ctx, since, emit)
	p.finishSession(ctx, started, "watch", err)
	return err
}

func (p *ObservedPlatform) finishSession(
	ctx context.Context, started time.Time, operation string, err error,
) {
	result := effectResult(err)
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		result = "canceled"
	} else if err != nil {
		p.logger.ErrorContext(ctx, "Runtime deployment platform session failed",
			"operation", operation, "platform", p.platform,
			"error_class", "platform_session_failed", "error", diagnostics.Message(err),
		)
	}
	attributes := []attribute.KeyValue{
		attribute.String("antnest.platform", p.platform),
		attribute.String("antnest.platform.operation", operation),
		attribute.String("antnest.result", result),
	}
	metricCtx := context.WithoutCancel(ctx)
	platformCalls.Add(metricCtx, 1, metric.WithAttributes(attributes...))
	platformDuration.Record(
		metricCtx, time.Since(started).Seconds(), metric.WithAttributes(attributes...),
	)
}

func (p *ObservedPlatform) mutate(
	ctx context.Context,
	operation string,
	key deployment.Key,
	execute func(context.Context) deployment.EffectOutcome,
) deployment.EffectOutcome {
	started := time.Now()
	ctx, span := platformTracer.Start(ctx, "runtime.platform."+operation)
	setRuntimeAttributes(span, key)
	outcome := execute(ctx)
	result := string(outcome.State)
	if result == "" {
		result = "invalid"
	}
	operationErr := outcome.Cause
	if outcome.State != deployment.EffectCompleted {
		if operationErr == nil {
			operationErr = fmt.Errorf("platform outcome %s", result)
		}
	}
	p.finish(ctx, span, started, operation, result, operationErr)
	p.logger.InfoContext(ctx, "Runtime platform mutation completed",
		"operation", operation, "platform", p.platform,
		"agent_id", key.AgentID, "generation", key.Generation,
		"effect", outcome.State, "error_code", outcome.Code,
	)
	return outcome
}

func (p *ObservedPlatform) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	result string,
	err error,
) {
	attributes := []attribute.KeyValue{
		attribute.String("antnest.platform", p.platform),
		attribute.String("antnest.platform.operation", operation),
		attribute.String("antnest.result", result),
	}
	span.SetAttributes(attributes...)
	if err != nil {
		span.RecordError(diagnostics.Error(err))
		span.SetStatus(codes.Error, result)
		p.logger.ErrorContext(ctx, "Runtime deployment platform operation failed",
			"operation", operation, "platform", p.platform,
			"error_class", "platform_operation_failed", "error", diagnostics.Message(err),
		)
	}
	span.End()
	platformCalls.Add(ctx, 1, metric.WithAttributes(attributes...))
	platformDuration.Record(
		ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...),
	)
}

func effectResult(err error) string {
	if err != nil {
		return "error"
	}
	return "completed"
}

func setRuntimeAttributes(span trace.Span, key deployment.Key) {
	span.SetAttributes(
		attribute.String("antnest.agent.id", key.AgentID),
		attribute.Int64("antnest.runtime.generation", int64(key.Generation)),
	)
}
