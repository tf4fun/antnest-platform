package identity

import (
	"context"
	"errors"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const resolveMetricName = "antnest.gateway.identity.resolve."

type resolveMetrics struct {
	meter        metric.Meter
	decisions    metric.Int64Counter
	calls        metric.Int64Counter
	duration     metric.Float64Histogram
	registration metric.Registration
	closeOnce    sync.Once
}

func newResolveMetrics() (*resolveMetrics, error) {
	meter := otel.Meter(resolveInstrumentation)
	decisions, decisionErr := meter.Int64Counter(resolveMetricName+"decisions", metric.WithDescription("Resolve request decisions, including cache and shared work"))
	calls, callErr := meter.Int64Counter(resolveMetricName+"rpc.calls", metric.WithDescription("Actual live Resolve attempts, including background refresh"))
	duration, durationErr := meter.Float64Histogram(resolveMetricName+"rpc.duration", metric.WithUnit("s"),
		metric.WithDescription("Actual Resolve attempt duration through response validation"))
	if err := errors.Join(decisionErr, callErr, durationErr); err != nil {
		return nil, err
	}
	return &resolveMetrics{meter: meter, decisions: decisions, calls: calls, duration: duration}, nil
}

func (metrics *resolveMetrics) decision(ctx context.Context, source, profile, outcome string) {
	metrics.decisions.Add(ctx, 1, metric.WithAttributes(attribute.String("source", source),
		attribute.String("profile", profile), attribute.String("outcome", outcome)))
}

func (metrics *resolveMetrics) rpc(ctx context.Context, profile, outcome string, elapsed time.Duration) {
	attributes := metric.WithAttributes(attribute.String("profile", profile), attribute.String("outcome", outcome))
	metrics.calls.Add(ctx, 1, attributes)
	metrics.duration.Record(ctx, elapsed.Seconds(), attributes)
}

func (metrics *resolveMetrics) observeCache(cache *resolveCache) error {
	// The Gateway owns one Identity client. These gauges describe its retained
	// state, not process RSS or the number of currently reusable entries.
	entries, entriesErr := metrics.meter.Int64ObservableGauge(resolveMetricName + "cache.entries")
	bytes, bytesErr := metrics.meter.Int64ObservableGauge(resolveMetricName+"cache.accounted_bytes", metric.WithUnit("By"))
	work, workErr := metrics.meter.Int64ObservableGauge(resolveMetricName + "cache.work")
	waiters, waitersErr := metrics.meter.Int64ObservableGauge(resolveMetricName + "cache.waiters")
	available, availableErr := metrics.meter.Int64ObservableGauge(resolveMetricName + "cache.proof.available")
	fresh, freshErr := metrics.meter.Int64ObservableGauge(resolveMetricName + "cache.proof.fresh")
	age, ageErr := metrics.meter.Float64ObservableGauge(resolveMetricName+"cache.proof.age", metric.WithUnit("s"))
	if err := errors.Join(entriesErr, bytesErr, workErr, waitersErr, availableErr, freshErr, ageErr); err != nil {
		return err
	}
	registration, err := metrics.meter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		cache.mu.Lock()
		closed := cache.closed
		entryCount, byteCount, workCount, waiterCount, proof := len(cache.entries), cache.bytes, cache.active, cache.waiters, cache.proof
		now := time.Now()
		proofFresh := cache.freshProof(now)
		cache.mu.Unlock()
		if closed {
			return nil
		}
		observer.ObserveInt64(entries, int64(entryCount))
		observer.ObserveInt64(bytes, int64(byteCount))
		observer.ObserveInt64(work, int64(workCount))
		observer.ObserveInt64(waiters, int64(waiterCount))
		var proofAvailable, isFresh int64
		if !proof.IsZero() && !proof.After(now) {
			proofAvailable = 1
			observer.ObserveFloat64(age, now.Sub(proof).Seconds())
		}
		if proofFresh {
			isFresh = 1
		}
		observer.ObserveInt64(available, proofAvailable)
		observer.ObserveInt64(fresh, isFresh)
		return nil
	}, entries, bytes, work, waiters, available, fresh, age)
	if err == nil {
		metrics.registration = registration
	}
	return err
}

func (metrics *resolveMetrics) close() {
	metrics.closeOnce.Do(func() {
		if metrics.registration != nil {
			// Never hold cache.mu here: SDK collection invokes the callback
			// with its own lock, which Unregister also needs.
			if err := metrics.registration.Unregister(); err != nil {
				otel.Handle(err)
			}
		}
	})
}
