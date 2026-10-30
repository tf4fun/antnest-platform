package telemetry

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func metricSum(data metricdata.ResourceMetrics, name string) float64 {
	var total float64
	for _, scope := range data.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != name {
				continue
			}
			sum, ok := instrument.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, point := range sum.DataPoints {
				total += float64(point.Value)
			}
		}
	}
	return total
}

func metricAttributeKeys(data metricdata.ResourceMetrics, name string) [][]string {
	var keys [][]string
	for _, scope := range data.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if instrument.Name != name {
				continue
			}
			sum, ok := instrument.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, point := range sum.DataPoints {
				var attrs []string
				for _, kv := range point.Attributes.ToSlice() {
					attrs = append(attrs, string(kv.Key))
				}
				keys = append(keys, attrs)
			}
		}
	}
	return keys
}

func TestLifecycleQuarantineMetric(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previousAppends, previousQuarantined := eventJournalAppends, lifecycleQuarantined
	eventJournalAppends = mustCounter(provider.Meter(instrumentationName + "/event").Int64Counter(
		"antnest.agent_controller.event_journal.appends"))
	lifecycleQuarantined = mustCounter(provider.Meter(instrumentationName + "/event").Int64Counter(
		"antnest_agent_lifecycle_quarantined_total"))
	t.Cleanup(func() {
		eventJournalAppends, lifecycleQuarantined = previousAppends, previousQuarantined
		_ = provider.Shutdown(context.Background())
	})
	ctx := context.Background()
	RecordAgentEventAppend(ctx, ports.EventAgentLifecycleQuarantined)
	RecordAgentEventAppend(ctx, ports.EventAgentLifecycleQuarantineCleared)
	RecordAgentEventAppend(ctx, ports.EventAgentLifecycleCancelled)
	RecordAgentEventAppend(ctx, ports.EventAgentBuildFailed)
	var data metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(ctx, &data))
	require.Equal(t, float64(1), metricSum(data, "antnest_agent_lifecycle_quarantined_total"))
	require.Equal(t, float64(4), metricSum(data, "antnest.agent_controller.event_journal.appends"))
	for _, attrs := range metricAttributeKeys(data, "antnest_agent_lifecycle_quarantined_total") {
		require.Empty(t, attrs, "quarantine counter must not carry labels")
	}
}
