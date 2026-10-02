package monitor

import (
	"context"
	"errors"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestReconciliationFailuresAreCountedWithoutCountingRecovery(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	counter, err := provider.Meter("monitor-test").Int64Counter("runtime_controller_observation_reconcile_failures_total")
	if err != nil {
		t.Fatal(err)
	}
	original := reconciliationFailures
	reconciliationFailures = counter
	t.Cleanup(func() {
		reconciliationFailures = original
		_ = provider.Shutdown(context.Background())
	})
	source := &recoveringSource{listErrors: []error{errors.New("socket unavailable"), errors.New("socket unavailable")}}
	runner := newRecoveryTestRunner(t, source, &fakeHealth{})
	for i := 0; i < 3; i++ {
		err := runner.Reconcile(context.Background(), false)
		if (i < 2) != (err != nil) {
			t.Fatalf("reconciliation %d returned %v", i, err)
		}
	}
	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatal(err)
	}
	for _, scope := range data.ScopeMetrics {
		for _, value := range scope.Metrics {
			if value.Name != "runtime_controller_observation_reconcile_failures_total" {
				continue
			}
			sum, ok := value.Data.(metricdata.Sum[int64])
			if !ok || len(sum.DataPoints) != 1 || sum.DataPoints[0].Value != 2 {
				t.Fatalf("failure counter = %+v, want 2", value.Data)
			}
			return
		}
	}
	t.Fatal("reconciliation failure metric was not emitted")
}
