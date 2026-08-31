package monitor

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
	monitorMeter       = otel.Meter("soft/antnest-platform/runtime-controller/platform-monitor")
	monitorTracer      = otel.Tracer("soft/antnest-platform/runtime-controller/platform-monitor")
	watchReconnects    = mustCounter(monitorMeter.Int64Counter("runtime.platform.watch.reconnects"))
	reconciliations    = mustCounter(monitorMeter.Int64Counter("runtime.platform.reconciliations"))
	reconciliationGaps = mustCounter(monitorMeter.Int64Counter("runtime.platform.reconciliation.gaps"))
)

type Source interface {
	List(context.Context) ([]deployment.Inspection, error)
	Watch(context.Context, time.Time, func(context.Context, deployment.Observation) error) error
}

type Sink interface {
	InspectPlatformRuntime(context.Context, deployment.Key) (deployment.Inspection, error)
	ValidateRuntimeInspection(context.Context, deployment.Inspection) error
	RecordPlatformObservation(context.Context, deployment.Observation) (deployment.Observation, error)
}

type Health interface {
	MarkMonitor(bool)
}

type Leadership interface {
	Done() <-chan struct{}
	Err() error
	Release(context.Context) error
}

type Coordinator interface {
	TryAcquireObservationLeadership(context.Context) (Leadership, bool, error)
}

type Runner struct {
	source     Source
	sink       Sink
	health     Health
	logger     *slog.Logger
	retryDelay time.Duration
	now        func() time.Time
}

func New(
	source Source, sink Sink, health Health, logger *slog.Logger, retryDelay time.Duration,
) (*Runner, error) {
	if source == nil || sink == nil || health == nil || logger == nil {
		return nil, fmt.Errorf("platform source, observation sink, health tracker, and logger are required")
	}
	if retryDelay <= 0 {
		return nil, fmt.Errorf("platform Watch retry delay must be positive")
	}
	return &Runner{
		source: source, sink: sink, health: health, logger: logger,
		retryDelay: retryDelay, now: time.Now,
	}, nil
}

func (r *Runner) Reconcile(ctx context.Context, afterGap bool) (resultErr error) {
	ctx, span := monitorTracer.Start(ctx, "runtime.platform.reconcile")
	span.SetAttributes(attribute.Bool("antnest.observation.after_gap", afterGap))
	defer func() {
		result := "completed"
		if resultErr != nil {
			result = "error"
			span.RecordError(diagnostics.Error(resultErr))
			span.SetStatus(codes.Error, "platform reconciliation failed")
		}
		span.SetAttributes(attribute.String("antnest.result", result))
		span.End()
		reconciliations.Add(ctx, 1, metric.WithAttributes(attribute.String("antnest.result", result)))
	}()
	r.health.MarkMonitor(false)
	if afterGap {
		if err := r.record(ctx, deployment.Observation{
			Kind: deployment.ObservationGap, Source: "platform_reconciliation",
			DiagnosticSummary: "Platform event stream disconnected; current inventory must be reconciled",
			ObservedAt:        r.now().UTC(),
		}); err != nil {
			return fmt.Errorf("record platform observation gap: %w", err)
		}
		reconciliationGaps.Add(ctx, 1)
	}
	inspections, err := r.source.List(ctx)
	if err != nil {
		return fmt.Errorf("list managed Runtime resources: %w", err)
	}
	for _, inspection := range inspections {
		if err := r.sink.ValidateRuntimeInspection(ctx, inspection); err != nil {
			return fmt.Errorf("validate managed Runtime inventory: %w", err)
		}
		observation, ok := observationFromInspection(inspection)
		if !ok {
			continue
		}
		if err := r.record(ctx, observation); err != nil {
			return err
		}
	}
	if err := r.record(ctx, deployment.Observation{
		Kind: deployment.ObservationReconciled, Source: "platform_reconciliation",
		DiagnosticSummary: "Current managed Runtime inventory was reconciled",
		ObservedAt:        r.now().UTC(),
	}); err != nil {
		return fmt.Errorf("record platform reconciliation: %w", err)
	}
	r.health.MarkMonitor(true)
	return nil
}

func (r *Runner) Run(ctx context.Context, since time.Time) error {
	for {
		watchErr := r.source.Watch(ctx, since, func(eventCtx context.Context, value deployment.Observation) error {
			return r.record(eventCtx, value)
		})
		if ctx.Err() != nil {
			return nil
		}
		r.health.MarkMonitor(false)
		watchReconnects.Add(ctx, 1)
		r.logger.WarnContext(ctx, "platform event stream disconnected",
			"component", "platform_watch", "result", "disconnected",
			"error_class", "platform_watch_disconnected", "error", diagnostics.Message(watchErr))
		disconnectedAt := r.now().UTC()
		for {
			if reconcileErr := r.Reconcile(ctx, true); reconcileErr == nil {
				break
			} else {
				r.logger.ErrorContext(ctx, "platform reconciliation failed",
					"component", "platform_reconciliation", "result", "error",
					"error_class", "platform_reconciliation_failed", "error", diagnostics.Message(reconcileErr))
			}
			if !wait(ctx, r.retryDelay) {
				return nil
			}
		}
		since = disconnectedAt
		if !wait(ctx, r.retryDelay) {
			return nil
		}
	}
}

func (r *Runner) RunCoordinated(
	ctx context.Context, coordinator Coordinator, ready func(),
) error {
	if coordinator == nil || ready == nil {
		return fmt.Errorf("observation coordinator and readiness callback are required")
	}
	for {
		leadership, acquired, err := coordinator.TryAcquireObservationLeadership(ctx)
		if err != nil {
			r.health.MarkMonitor(false)
			return fmt.Errorf("acquire observation monitor leadership: %w", err)
		}
		if !acquired {
			r.health.MarkMonitor(true)
			ready()
			if !wait(ctx, r.retryDelay) {
				return nil
			}
			continue
		}

		r.health.MarkMonitor(false)
		leaderCtx, cancelLeader := context.WithCancel(ctx)
		leaseWatchDone := make(chan struct{})
		go func() {
			defer close(leaseWatchDone)
			select {
			case <-leadership.Done():
				cancelLeader()
			case <-leaderCtx.Done():
			}
		}()
		watchSince := r.now().UTC()
		reconcileErr := r.Reconcile(leaderCtx, true)
		var runErr error
		if reconcileErr == nil {
			ready()
			runErr = r.Run(leaderCtx, watchSince)
		}
		leaseLost := leadershipEnded(leadership)
		cancelLeader()
		<-leaseWatchDone
		releaseErr := releaseLeadership(leadership)
		if ctx.Err() != nil {
			return errors.Join(reconcileErr, runErr, releaseErr)
		}
		if leaseLost {
			r.health.MarkMonitor(false)
			r.logger.WarnContext(ctx, "observation monitor leadership was lost",
				"component", "platform_watch", "result", "disconnected",
				"error_class", "observation_leadership_lost",
				"error", diagnostics.Message(leadership.Err()))
			if !wait(ctx, r.retryDelay) {
				return nil
			}
			continue
		}
		if reconcileErr != nil {
			return errors.Join(reconcileErr, releaseErr)
		}
		if err := errors.Join(runErr, releaseErr); err != nil {
			return err
		}
	}
}

func leadershipEnded(leadership Leadership) bool {
	select {
	case <-leadership.Done():
		return true
	default:
		return false
	}
}

func releaseLeadership(leadership Leadership) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return leadership.Release(ctx)
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func (r *Runner) record(
	ctx context.Context, value deployment.Observation,
) (resultErr error) {
	ctx, span := monitorTracer.Start(ctx, "runtime.platform.observation.process", trace.WithSpanKind(trace.SpanKindConsumer))
	span.SetAttributes(
		attribute.String("antnest.agent.id", value.AgentID),
		attribute.Int64("antnest.runtime.generation", int64(value.Generation)),
	)
	defer func() {
		if resultErr != nil {
			span.RecordError(diagnostics.Error(resultErr))
			span.SetStatus(codes.Error, "platform observation processing failed")
		}
		span.End()
	}()
	if value.ObservedAt.IsZero() {
		value.ObservedAt = r.now().UTC()
	}
	if value.Kind == deployment.ObservationHealthy {
		key, ok := value.RuntimeKey()
		if !ok {
			return fmt.Errorf("healthy platform observation has invalid Runtime identity")
		}
		inspection, err := r.sink.InspectPlatformRuntime(ctx, key)
		if err != nil {
			value.Kind = deployment.ObservationStatusUnverified
			value.DiagnosticSummary = "Runtime status could not be verified"
		} else if current, currentOK := observationFromInspection(inspection); currentOK {
			value = current
		}
	}
	span.SetAttributes(observationTraceAttributes(value)...)
	if _, err := r.sink.RecordPlatformObservation(ctx, value); err != nil {
		return fmt.Errorf("record Runtime platform observation: %w", err)
	}
	return nil
}

func observationTraceAttributes(value deployment.Observation) []attribute.KeyValue {
	return []attribute.KeyValue{
		attribute.String("antnest.observation.kind", string(value.Kind)),
		attribute.String("antnest.observation.source", value.Source),
		attribute.String("antnest.runtime.spec_digest", value.SpecDigest),
		attribute.String("antnest.runtime.platform_resource_id", value.PlatformResourceID),
		attribute.String("antnest.runtime.execution_id", value.RuntimeExecutionID),
	}
}

func observationFromInspection(
	inspection deployment.Inspection,
) (deployment.Observation, bool) {
	key := inspection.RuntimeKey()
	if err := key.Validate(); err != nil {
		return deployment.Observation{}, false
	}
	var kind deployment.ObservationKind
	switch {
	case inspection.PlatformPhase == deployment.PhaseAbsent:
		kind = deployment.ObservationDeleted
	case inspection.PlatformPhase == deployment.PhaseExited:
		kind = deployment.ObservationExited
	case inspection.Health == deployment.HealthHealthy:
		kind = deployment.ObservationHealthy
	case inspection.Health == deployment.HealthUnhealthy:
		kind = deployment.ObservationUnhealthy
	default:
		return deployment.Observation{}, false
	}
	return deployment.Observation{
		AgentID: inspection.AgentID, Generation: inspection.Generation,
		SpecDigest:         inspection.SpecDigest,
		PlatformResourceID: inspection.PlatformResourceID,
		RuntimeExecutionID: inspection.RuntimeExecutionID,
		Kind:               kind, Source: "platform_reconciliation", ObservedAt: inspection.ObservedAt,
	}, true
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
