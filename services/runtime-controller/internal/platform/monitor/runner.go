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

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/diagnostics"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

var (
	monitorMeter           = otel.Meter("github.com/tf4fun/antnest-platform/runtime-controller/platform-monitor")
	monitorTracer          = otel.Tracer("github.com/tf4fun/antnest-platform/runtime-controller/platform-monitor")
	watchReconnects        = mustCounter(monitorMeter.Int64Counter("runtime.platform.watch.reconnects"))
	reconciliations        = mustCounter(monitorMeter.Int64Counter("runtime.platform.reconciliations"))
	reconciliationGaps     = mustCounter(monitorMeter.Int64Counter("runtime.platform.reconciliation.gaps"))
	reconciliationFailures = mustCounter(monitorMeter.Int64Counter("runtime_controller_observation_reconcile_failures_total"))
)

type Sink interface {
	InspectPlatformRuntime(context.Context, deployment.Key) (deployment.Inspection, error)
	ValidateRuntimeInspection(context.Context, deployment.Inspection) error
	RecordPlatformObservation(context.Context, deployment.Observation) (deployment.Observation, error)
	ReconcileExpectedRuntimes(context.Context, []deployment.Inspection) error
	ReconcileRetainedStorage(context.Context) error
}

type Health interface {
	MarkMonitor(bool)
}

type Runner struct {
	source           platform.ObservationSource
	sink             Sink
	health           Health
	logger           *slog.Logger
	retryDelay       time.Duration
	maxRetryDelay    time.Duration
	reconcileTimeout time.Duration
	now              func() time.Time
	wait             func(context.Context, time.Duration) bool
}

func New(
	source platform.ObservationSource,
	sink Sink,
	health Health,
	logger *slog.Logger,
	retryDelay time.Duration,
	maxRetryDelay time.Duration,
	reconcileTimeout time.Duration,
) (*Runner, error) {
	if source == nil || sink == nil || health == nil || logger == nil {
		return nil, &PermanentError{Err: fmt.Errorf("platform source, observation sink, health tracker, and logger are required")}
	}
	if retryDelay <= 0 {
		return nil, &PermanentError{Err: fmt.Errorf("platform Watch retry delay must be positive")}
	}
	if maxRetryDelay < retryDelay {
		return nil, &PermanentError{Err: fmt.Errorf("platform Watch maximum retry delay must not be below the initial delay")}
	}
	if reconcileTimeout <= 0 {
		return nil, &PermanentError{Err: fmt.Errorf("platform reconciliation timeout must be positive")}
	}
	return &Runner{
		source: source, sink: sink, health: health, logger: logger,
		retryDelay: retryDelay, maxRetryDelay: maxRetryDelay,
		reconcileTimeout: reconcileTimeout, now: time.Now, wait: wait,
	}, nil
}

func (r *Runner) Reconcile(ctx context.Context, afterGap bool) (resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, r.reconcileTimeout)
	defer cancel()
	ctx, span := monitorTracer.Start(ctx, "runtime.platform.reconcile")
	span.SetAttributes(attribute.Bool("antnest.observation.after_gap", afterGap))
	defer func() {
		result := "completed"
		if resultErr != nil {
			result = "error"
			reconciliationFailures.Add(ctx, 1)
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
	if err := r.sink.ReconcileExpectedRuntimes(ctx, inspections); err != nil {
		return fmt.Errorf("reconcile expected Runtime inventory: %w", err)
	}
	if err := r.sink.ReconcileRetainedStorage(ctx); err != nil {
		return fmt.Errorf("reconcile retained Runtime storage: %w", err)
	}
	if err := r.record(ctx, deployment.Observation{
		Kind: deployment.ObservationReconciled, Source: "platform_reconciliation",
		DiagnosticSummary: "Current managed Runtime inventory was reconciled",
		ObservedAt:        r.now().UTC(),
	}); err != nil {
		return fmt.Errorf("record platform reconciliation: %w", err)
	}
	return nil
}

func (r *Runner) Run(
	ctx context.Context,
	since time.Time,
	onReady func(context.Context) error,
	onUnready func(context.Context) error,
) error {
	if onReady == nil || onUnready == nil {
		return &PermanentError{Err: fmt.Errorf("platform Watch readiness callbacks are required")}
	}
	backoff := newRetryBackoff(r.retryDelay, r.maxRetryDelay)
	for {
		watchReady := false
		watchErr := r.source.Watch(
			ctx,
			since,
			func(readyCtx context.Context) error {
				if err := onReady(readyCtx); err != nil {
					return err
				}
				watchReady = true
				backoff.reset()
				r.health.MarkMonitor(true)
				return nil
			},
			func(eventCtx context.Context, value deployment.Observation) error {
				return r.record(eventCtx, value)
			},
		)
		if watchReady {
			r.health.MarkMonitor(false)
			if err := callWithTimeout(onUnready); err != nil && ctx.Err() == nil {
				return errors.Join(watchErr, fmt.Errorf("withdraw platform Watch readiness: %w", err))
			}
		}
		if ctx.Err() != nil {
			return nil
		}
		if isPermanent(watchErr) {
			r.health.MarkMonitor(false)
			return watchErr
		}
		watchReconnects.Add(ctx, 1)
		r.logger.WarnContext(ctx, "platform event stream disconnected",
			"component", "platform_watch", "result", "disconnected",
			"error_class", "platform_watch_disconnected", "error", diagnostics.Message(watchErr))
		disconnectedAt := r.now().UTC()
		for {
			if reconcileErr := r.Reconcile(ctx, true); reconcileErr == nil {
				break
			} else {
				if isPermanent(reconcileErr) {
					return reconcileErr
				}
				if !r.retry(ctx, backoff, "platform_reconciliation_failed", "platform reconciliation failed", reconcileErr) {
					return nil
				}
			}
		}
		since = disconnectedAt
		if !r.wait(ctx, backoff.next()) {
			return nil
		}
	}
}

func (r *Runner) RunCoordinated(
	ctx context.Context, coordinator repository.ObservationCoordinator, ready func(),
) error {
	if coordinator == nil || ready == nil {
		return &PermanentError{Err: fmt.Errorf("observation coordinator and readiness callback are required")}
	}
	backoff := newRetryBackoff(r.retryDelay, r.maxRetryDelay)
	for {
		if ctx.Err() != nil {
			return nil
		}
		leadership, acquired, err := coordinator.TryAcquireObservationLeadership(ctx)
		if err != nil {
			r.health.MarkMonitor(false)
			if isPermanent(err) {
				return fmt.Errorf("acquire observation monitor leadership: %w", err)
			}
			if !r.retry(ctx, backoff, "observation_leadership_query_failed", "observation leadership query failed", err) {
				return nil
			}
			continue
		}
		if !acquired {
			monitorReady, readyErr := coordinator.ObservationMonitorReady(ctx)
			if readyErr != nil {
				r.health.MarkMonitor(false)
				if isPermanent(readyErr) {
					return fmt.Errorf("probe observation monitor readiness: %w", readyErr)
				}
				if !r.retry(ctx, backoff, "observation_leadership_query_failed", "observation readiness query failed", readyErr) {
					return nil
				}
				continue
			}
			r.health.MarkMonitor(monitorReady)
			if monitorReady {
				backoff.reset()
				ready()
			}
			if !r.wait(ctx, r.retryDelay) {
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
			runErr = r.Run(
				leaderCtx,
				watchSince,
				func(readyCtx context.Context) error {
					if err := leadership.MarkObservationReady(readyCtx); err != nil {
						return err
					}
					backoff.reset()
					r.health.MarkMonitor(true)
					ready()
					return nil
				},
				leadership.MarkObservationUnready,
			)
		}
		leaseLost := leadershipEnded(leadership)
		cancelLeader()
		<-leaseWatchDone
		releaseErr := releaseLeadership(leadership)
		r.health.MarkMonitor(false)
		if ctx.Err() != nil {
			return nil
		}
		resultErr := errors.Join(reconcileErr, runErr, releaseErr)
		if isPermanent(resultErr) {
			return resultErr
		}
		if leaseLost {
			if !r.retry(ctx, backoff, "observation_leadership_lost", "observation monitor leadership was lost", errors.Join(leadership.Err(), resultErr)) {
				return nil
			}
			continue
		}
		if reconcileErr != nil {
			if !r.retry(ctx, backoff, "observation_reconcile_failed", "observation reconciliation failed", resultErr) {
				return nil
			}
			continue
		}
		if resultErr != nil {
			if !r.retry(ctx, backoff, "observation_monitor_run_failed", "observation monitor run failed", resultErr) {
				return nil
			}
			continue
		}
		return &PermanentError{Err: errors.New("observation monitor stopped unexpectedly")}
	}
}

func (r *Runner) retry(ctx context.Context, backoff *retryBackoff, class, message string, err error) bool {
	r.health.MarkMonitor(false)
	if ctx.Err() != nil {
		return false
	}
	delay := backoff.next()
	r.logger.WarnContext(ctx, message,
		"component", "platform_monitor", "result", "retrying", "error_class", class,
		"error", diagnostics.Message(err), "retry_delay", delay.String())
	return r.wait(ctx, delay)
}

func leadershipEnded(leadership repository.Leadership) bool {
	select {
	case <-leadership.Done():
		return true
	default:
		return false
	}
}

func releaseLeadership(leadership repository.Leadership) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return errors.Join(leadership.MarkObservationUnready(ctx), leadership.Release(ctx))
}

func callWithTimeout(callback func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return callback(ctx)
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
			if !errors.Is(err, deployment.ErrStatusUnverified) {
				return fmt.Errorf("inspect observed Runtime: %w", err)
			}
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
		kind = deployment.ObservationRuntimeDeleted
	case inspection.PlatformPhase == deployment.PhaseExited:
		kind = deployment.ObservationExited
	case inspection.Health == deployment.HealthHealthy:
		kind = deployment.ObservationHealthy
	case inspection.Health == deployment.HealthUnhealthy:
		kind = deployment.ObservationUnhealthy
	case inspection.Health == deployment.HealthStarting || inspection.PlatformPhase == deployment.PhaseCreated:
		kind = deployment.ObservationStarting
	default:
		kind = deployment.ObservationStatusUnverified
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
