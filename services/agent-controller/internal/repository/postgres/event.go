package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ListAgentEvents(
	ctx context.Context, query ports.AgentEventQuery,
) ([]ports.AgentEventRecord, error) {
	if query.AfterSequence < 0 || query.Limit < 1 {
		return nil, fmt.Errorf("query Agent events: invalid cursor or limit")
	}
	statement := `
	SELECT event.global_sequence, event.event_id, event.agent_id,
	       event.aggregate_sequence, event.schema_version, event.event_type,
	       event.operation_request_id, event.trace_id,
	       event.data, event.occurred_at
	FROM agent_controller.agent_events AS event
	JOIN agent_controller.agents AS agent ON agent.id = event.agent_id
	WHERE event.global_sequence > $1`
	arguments := []any{query.AfterSequence}
	if query.OrganizationID != "" {
		arguments = append(arguments, query.OrganizationID)
		statement += fmt.Sprintf(" AND agent.organization_id = $%d", len(arguments))
	}
	if query.AgentID != "" {
		arguments = append(arguments, query.AgentID)
		statement += fmt.Sprintf(" AND event.agent_id = $%d", len(arguments))
	}
	arguments = append(arguments, query.Limit)
	statement += fmt.Sprintf(" ORDER BY event.global_sequence LIMIT $%d", len(arguments))
	rows, err := repository.pool.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query Agent events: %w", err)
	}
	defer rows.Close()
	records := make([]ports.AgentEventRecord, 0, query.Limit)
	for rows.Next() {
		record, scanErr := scanAgentEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Agent events: %w", err)
	}
	return records, nil
}

func scanAgentEvent(scanner lifecycleRowScanner) (ports.AgentEventRecord, error) {
	var record ports.AgentEventRecord
	var payload []byte
	if err := scanner.Scan(
		&record.GlobalSequence, &record.EventID, &record.AgentID, &record.AggregateSequence,
		&record.SchemaVersion, &record.EventType, &record.OperationRequestID,
		&record.TraceID, &payload, &record.OccurredAt,
	); err != nil {
		return ports.AgentEventRecord{}, fmt.Errorf("scan Agent event: %w", err)
	}
	if err := json.Unmarshal(payload, &record.Data); err != nil {
		return ports.AgentEventRecord{}, fmt.Errorf("decode Agent event data: %w", err)
	}
	return record, nil
}

var _ ports.AgentEventStore = (*Repository)(nil)
