package telemetry

import (
	"context"
	"fmt"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"soft/antnest-platform/services/agent-controller/internal/ports"
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

type ObservedAgentEventStore struct {
	next   ports.AgentEventStore
	logger *slog.Logger
}

func ObserveAgentEventStore(
	next ports.AgentEventStore, logger *slog.Logger,
) (*ObservedAgentEventStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("agent event store and logger are required")
	}
	return &ObservedAgentEventStore{next: next, logger: logger}, nil
}

func (store *ObservedAgentEventStore) ListAgentEvents(
	ctx context.Context, query ports.AgentEventQuery,
) (records []ports.AgentEventRecord, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "list_agent_events")
	defer func() {
		if resultErr == nil {
			span.SetAttributes(attribute.Int("antnest.query.item_count", len(records)))
		}
		finishRepositorySpan(ctx, store.logger, span, started, "list_agent_events", resultErr)
	}()
	records, resultErr = store.next.ListAgentEvents(ctx, query)
	return records, resultErr
}

var _ ports.AgentEventStore = (*ObservedAgentEventStore)(nil)
