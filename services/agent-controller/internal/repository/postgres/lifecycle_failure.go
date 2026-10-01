package postgres

import (
	"context"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"strings"
	"time"
)

func (repository *Repository) QuarantineLifecycleOperation(
	ctx context.Context, input ports.QuarantineLifecycleOperation,
) error {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.Fingerprint) == "" ||
		input.ExpectedPhase == "" || strings.TrimSpace(input.ErrorCode) == "" ||
		strings.TrimSpace(input.ErrorDetail) == "" || strings.TrimSpace(input.EventID) == "" {
		return fmt.Errorf("invalid lifecycle quarantine")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin lifecycle quarantine: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return err
	}
	if operation.RequestFingerprint != input.Fingerprint {
		return ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning {
		return nil
	}
	if operation.Phase != input.ExpectedPhase {
		return ports.ErrConcurrentChange
	}

	var aggregateSequence int64
	var activeOperationRequestID string
	var now time.Time
	if err := transaction.QueryRow(ctx, `
SELECT aggregate_sequence, active_operation_request_id, clock_timestamp()
FROM agent_controller.agents
WHERE id = $1
FOR UPDATE`, operation.AgentID).Scan(&aggregateSequence, &activeOperationRequestID, &now); err != nil {
		return fmt.Errorf("lock quarantined Agent: %w", err)
	}
	if activeOperationRequestID != input.RequestID {
		return ports.ErrConcurrentChange
	}
	nextSequence := aggregateSequence + 1
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET runtime_state = 'unknown', runtime_reason = 'lifecycle_invariant_failed', active_operation_request_id = '',
    executable_execution_revision_id = '', runtime_execution_id = '', runtime_mcp_endpoint = '',
    failure_stage = $2, failure_code = $3, failure_detail = $4,
    aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND active_operation_request_id = $7 AND aggregate_sequence = $8`,
		operation.AgentID, operation.Phase, input.ErrorCode, input.ErrorDetail,
		nextSequence, now, input.RequestID, aggregateSequence,
	)
	if err != nil {
		return fmt.Errorf("quarantine Agent lifecycle: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
		EventID: input.EventID, AgentID: operation.AgentID,
		AggregateSequence: nextSequence, SchemaVersion: 1,
		EventType:          ports.EventAgentLifecycleQuarantined,
		OperationRequestID: input.RequestID, TraceID: input.TraceID,
		Data: map[string]any{
			"failure_stage": operation.Phase,
			"failure_code":  input.ErrorCode,
		},
		OccurredAt: now,
	}); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = FALSE,
    updated_at = $4
WHERE request_id = $1`, input.RequestID, input.ErrorCode, input.ErrorDetail, now); err != nil {
		return fmt.Errorf("quarantine Agent lifecycle operation: %w", err)
	}
	if err := repository.advanceAgentExecutionRevision(ctx, transaction, operation.AgentID); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle quarantine: %w", err)
	}
	repository.recordEventAppend(ctx, ports.EventAgentLifecycleQuarantined)
	return nil
}

func authorizeLifecycleMutationOrReplay(
	operation ports.LifecycleOperationRecord,
	kind domain.OperationKind,
	fingerprint string,
	replayState domain.OperationState,
) (bool, error) {
	if operation.Kind != kind || operation.RequestFingerprint != fingerprint {
		return false, ports.ErrRequestConflict
	}
	if operation.State == replayState {
		return true, nil
	}
	if operation.State != domain.OperationRunning {
		return false, ports.ErrConcurrentChange
	}
	return false, nil
}
