package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var eventJournalAppends = mustCounter(
	otel.Meter(instrumentationName+"/event").Int64Counter(
		"antnest.agent_controller.event_journal.appends",
		metric.WithDescription("Committed Agent event journal appends"),
	),
)

var eventNotifierTransitions = mustCounter(
	otel.Meter(instrumentationName+"/event").Int64Counter(
		"antnest.agent_controller.event_notifier.transitions",
		metric.WithDescription("Agent event notifier connection transitions"),
	),
)

var lifecycleQuarantined = mustCounter(
	otel.Meter(instrumentationName+"/event").Int64Counter(
		"antnest_agent_lifecycle_quarantined_total",
		metric.WithDescription("Committed agent_lifecycle_quarantined event occurrences"),
	),
)

func RecordAgentEventAppend(ctx context.Context, eventType string) {
	eventJournalAppends.Add(
		ctx, 1, metric.WithAttributes(attribute.String("antnest.event.type", eventType)),
	)
	if eventType == ports.EventAgentLifecycleQuarantined {
		lifecycleQuarantined.Add(ctx, 1)
	}
}

func RecordAgentEventNotifierTransition(state string) {
	eventNotifierTransitions.Add(
		context.Background(), 1,
		metric.WithAttributes(attribute.String("antnest.event_notifier.state", state)),
	)
}
