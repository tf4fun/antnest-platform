package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const agentEventNotificationChannel = "agent_controller_events"

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

func (repository *Repository) WaitForAgentEvents(
	ctx context.Context, agentID string, afterSequence int64,
) error {
	if afterSequence < 0 {
		return fmt.Errorf("wait for Agent events: invalid cursor")
	}
	connection, err := repository.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire Agent event listener: %w", err)
	}
	defer releaseEventListener(connection)
	if _, err := connection.Exec(ctx, "LISTEN "+agentEventNotificationChannel); err != nil {
		return fmt.Errorf("listen for Agent events: %w", err)
	}
	statement := `SELECT EXISTS (
    SELECT 1 FROM agent_controller.agent_events WHERE global_sequence > $1`
	arguments := []any{afterSequence}
	if agentID != "" {
		statement += " AND agent_id = $2"
		arguments = append(arguments, agentID)
	}
	statement += ")"
	var available bool
	if err := connection.QueryRow(ctx, statement, arguments...).Scan(&available); err != nil {
		return fmt.Errorf("check Agent event journal after listen: %w", err)
	}
	if available {
		return nil
	}
	if _, err := connection.Conn().WaitForNotification(ctx); err != nil {
		return fmt.Errorf("wait for Agent event notification: %w", err)
	}
	return nil
}

func releaseEventListener(connection *pgxpool.Conn) {
	cleanupContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := connection.Exec(cleanupContext, "UNLISTEN "+agentEventNotificationChannel); err != nil {
		_ = connection.Conn().Close(cleanupContext)
	}
	connection.Release()
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
