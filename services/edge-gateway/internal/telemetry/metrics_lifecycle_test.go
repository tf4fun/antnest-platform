package telemetry

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestMetricsDisabledDoesNotExport(t *testing.T) {
	for _, mode := range []string{"default", "none", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			isolateMetricsEnvironment(t)
			var requests atomic.Int64
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
			defer receiver.Close()
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.URL)
			t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", receiver.URL+"/v1/metrics")
			switch mode {
			case "default":
				t.Setenv("OTEL_METRICS_EXPORTER", "")
			case "disabled":
				t.Setenv("OTEL_SDK_DISABLED", "true")
				t.Setenv("OTEL_METRICS_EXPORTER", "otlp")
			}
			runtime, err := Setup(context.Background(), slog.NewTextHandler(io.Discard, nil), Config{})
			if err != nil {
				t.Fatal(err)
			}
			counter, err := otel.Meter("test").Int64Counter("test.gateway.disabled")
			if err != nil {
				t.Fatal(err)
			}
			counter.Add(context.Background(), 1)
			if err := runtime.Shutdown(context.Background()); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 0 || runtime.meterProvider != nil {
				t.Fatal("disabled metrics initialized an export pipeline")
			}
		})
	}
}

type deadlineMetricExporter struct{ shutdowns int }

func (*deadlineMetricExporter) Temporality(kind sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(kind)
}
func (*deadlineMetricExporter) Aggregation(kind sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(kind)
}
func (*deadlineMetricExporter) Export(ctx context.Context, _ *metricdata.ResourceMetrics) error {
	<-ctx.Done()
	return ctx.Err()
}
func (*deadlineMetricExporter) ForceFlush(context.Context) error { return nil }
func (exporter *deadlineMetricExporter) Shutdown(context.Context) error {
	exporter.shutdowns++
	return nil
}

type shutdownTraceProcessor struct {
	shutdowns int
	err       error
	remaining time.Duration
}

func (*shutdownTraceProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (*shutdownTraceProcessor) OnEnd(sdktrace.ReadOnlySpan)                     {}
func (*shutdownTraceProcessor) ForceFlush(context.Context) error                { return nil }
func (processor *shutdownTraceProcessor) Shutdown(ctx context.Context) error {
	processor.shutdowns++
	deadline, _ := ctx.Deadline()
	processor.remaining = time.Until(deadline)
	return errors.Join(processor.err, ctx.Err())
}

func TestMetricsTimeoutKeepsIndependentTraceBudgetAndJoinsReader(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		exporter := &deadlineMetricExporter{}
		reader := sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(time.Hour))
		processor := &shutdownTraceProcessor{err: errors.New("trace flush failed")}
		runtime := &Runtime{
			meterProvider: sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)),
			provider:      sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(processor)),
		}
		started := time.Now()
		err := runtime.Shutdown(context.Background())
		if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, processor.err) || time.Since(started) != 5*time.Second ||
			processor.remaining != 5*time.Second || processor.shutdowns != 1 || exporter.shutdowns != 1 {
			t.Fatalf("signal failure/budget/join lost: err=%v elapsed=%v traceRemaining=%v", err, time.Since(started), processor.remaining)
		}
		if err := runtime.Shutdown(context.Background()); err != nil || processor.shutdowns != 1 || exporter.shutdowns != 1 {
			t.Fatal("shutdown repeated work or returned a stale failure")
		}
		// synctest also rejects a surviving PeriodicReader worker.
	})
}

func TestMetricsShutdownCancelledCallerStillCleansBothSignals(t *testing.T) {
	for _, timeout := range []time.Duration{0, 3 * time.Second} {
		t.Run(timeout.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				exporter := &deadlineMetricExporter{}
				processor := &shutdownTraceProcessor{}
				runtime := &Runtime{
					meterProvider: sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(time.Hour)))),
					provider:      sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(processor)),
				}
				ctx, cancel := context.WithTimeout(context.Background(), timeout)
				defer cancel()
				err := runtime.Shutdown(ctx)
				if !errors.Is(err, context.DeadlineExceeded) || exporter.shutdowns != 1 || processor.shutdowns != 1 || processor.remaining <= 0 {
					t.Fatalf("expired caller skipped resource cleanup: err=%v metrics=%d trace=%d remaining=%v", err, exporter.shutdowns, processor.shutdowns, processor.remaining)
				}
			})
		})
	}
}
