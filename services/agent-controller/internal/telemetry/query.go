package telemetry

import (
	"context"
	"fmt"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ObservedAgentQueryStore struct {
	next   ports.AgentQueryStore
	logger *slog.Logger
}

func ObserveAgentQueryStore(
	next ports.AgentQueryStore, logger *slog.Logger,
) (*ObservedAgentQueryStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("agent query store and logger are required")
	}
	return &ObservedAgentQueryStore{next: next, logger: logger}, nil
}

func (store *ObservedAgentQueryStore) GetAgent(
	ctx context.Context, agentID string,
) (record ports.AgentRecord, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "get_agent")
	defer func() {
		finishRepositorySpan(ctx, store.logger, span, started, "get_agent", resultErr)
	}()
	record, resultErr = store.next.GetAgent(ctx, agentID)
	if resultErr == nil {
		span.SetAttributes(attribute.Int64("antnest.agent.aggregate_sequence", record.AggregateSequence))
	}
	return record, resultErr
}

func (store *ObservedAgentQueryStore) ListAgents(
	ctx context.Context, query ports.AgentQuery,
) (records []ports.AgentRecord, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "list_agents")
	defer func() {
		finishRepositorySpan(ctx, store.logger, span, started, "list_agents", resultErr)
	}()
	records, resultErr = store.next.ListAgents(ctx, query)
	if resultErr == nil {
		span.SetAttributes(attribute.Int("antnest.query.item_count", len(records)))
	}
	return records, resultErr
}

var _ ports.AgentQueryStore = (*ObservedAgentQueryStore)(nil)
