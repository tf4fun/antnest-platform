package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
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

func RecordAgentEventAppend(ctx context.Context, eventType string) {
	eventJournalAppends.Add(
		ctx, 1, metric.WithAttributes(attribute.String("antnest.event.type", eventType)),
	)
}

func RecordAgentEventNotifierTransition(state string) {
	eventNotifierTransitions.Add(
		context.Background(), 1,
		metric.WithAttributes(attribute.String("antnest.event_notifier.state", state)),
	)
}
