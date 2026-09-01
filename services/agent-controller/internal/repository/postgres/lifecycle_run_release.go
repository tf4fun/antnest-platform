package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) releaseBlockedRunAdmission(
	ctx context.Context,
	transaction pgx.Tx,
	operation ports.LifecycleOperationRecord,
	event ports.RunAdmissionEvent,
	now time.Time,
) (bool, error) {
	if !validRunEvent(event, domain.AdmissionReleased) || now.IsZero() {
		return false, fmt.Errorf("invalid lifecycle Run release event")
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return false, err
	}
	if agent.ActiveOperationRequestID != operation.RequestID {
		return false, ports.ErrConcurrentChange
	}

	var admissionID, runtimeRevision string
	err = transaction.QueryRow(ctx, `
SELECT admission_id, runtime_revision
FROM agent_controller.run_admissions
WHERE agent_id = $1 AND state = 'blocked_unknown_effect'
ORDER BY admission_id LIMIT 1 FOR UPDATE`, operation.AgentID).Scan(
		&admissionID, &runtimeRevision,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("load unresolved Run admission: %w", err)
	}
	if !operation.SourceRuntimeAbsent && runtimeRevision != operation.SourceRuntimeRevision {
		return false, fmt.Errorf("unresolved Run belongs to another Runtime revision")
	}

	released, err := transaction.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET state = 'released', released_by_operation_request_id = $2,
    released_at = $3, updated_at = $3
WHERE admission_id = $1 AND state = 'blocked_unknown_effect'`,
		admissionID, operation.RequestID, now,
	)
	if err != nil {
		return false, fmt.Errorf("release unresolved Run after Runtime removal: %w", err)
	}
	if released.RowsAffected() != 1 {
		return false, ports.ErrConcurrentChange
	}

	nextSequence := agent.AggregateSequence + 1
	projected, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET aggregate_sequence = $2, updated_at = $3
WHERE id = $1 AND active_operation_request_id = $4 AND aggregate_sequence = $5`,
		agent.AgentID, nextSequence, now, operation.RequestID, agent.AggregateSequence,
	)
	if err != nil {
		return false, fmt.Errorf("advance Agent Run release sequence: %w", err)
	}
	if projected.RowsAffected() != 1 {
		return false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
		EventID: event.EventID, AgentID: operation.AgentID,
		AggregateSequence: nextSequence, SchemaVersion: 1,
		EventType:          ports.EventRunAdmissionReleased,
		OperationRequestID: operation.RequestID, AdmissionID: admissionID,
		TraceID: event.TraceID, Data: event.Data, OccurredAt: event.OccurredAt,
	}); err != nil {
		return false, err
	}
	return true, nil
}

func emptyRunAdmissionEvent(event ports.RunAdmissionEvent) bool {
	return event.EventID == "" && event.EventType == "" && event.TraceID == "" &&
		event.Data == nil && event.OccurredAt.IsZero()
}
