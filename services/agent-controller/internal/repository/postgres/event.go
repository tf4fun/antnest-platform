package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ListAgentEvents(
	ctx context.Context, query ports.AgentEventQuery,
) ([]ports.AgentEventRecord, error) {
	if query.AfterSequence < 0 || query.Limit < 1 {
		return nil, fmt.Errorf("query Agent events: invalid cursor or limit")
	}
	statement := `
SELECT global_sequence, event_id, agent_id, aggregate_sequence, schema_version,
       event_type, operation_request_id, admission_id, trace_id, data, occurred_at
FROM agent_controller.agent_events
WHERE global_sequence > $1`
	arguments := []any{query.AfterSequence}
	if query.AgentID != "" {
		statement += " AND agent_id = $2"
		arguments = append(arguments, query.AgentID)
	}
	arguments = append(arguments, query.Limit)
	statement += fmt.Sprintf(" ORDER BY global_sequence LIMIT $%d", len(arguments))
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
		&record.AdmissionID, &record.TraceID, &payload, &record.OccurredAt,
	); err != nil {
		return ports.AgentEventRecord{}, fmt.Errorf("scan Agent event: %w", err)
	}
	if err := json.Unmarshal(payload, &record.Data); err != nil {
		return ports.AgentEventRecord{}, fmt.Errorf("decode Agent event data: %w", err)
	}
	return record, nil
}

var _ ports.AgentEventStore = (*Repository)(nil)
