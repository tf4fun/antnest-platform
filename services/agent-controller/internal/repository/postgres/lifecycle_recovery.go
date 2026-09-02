package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ClaimLifecycleRecovery(
	ctx context.Context, input ports.ClaimLifecycleRecovery,
) (ports.LifecycleRecoveryClaim, bool, error) {
	if strings.TrimSpace(input.WorkerID) == "" || input.LeaseDuration <= 0 {
		return ports.LifecycleRecoveryClaim{}, false, fmt.Errorf("invalid lifecycle recovery claim")
	}
	row := repository.pool.QueryRow(ctx, `
WITH candidate AS (
    SELECT request_id
    FROM agent_controller.agent_lifecycle_operations
    WHERE state = 'running'
      AND recovery_after <= clock_timestamp()
      AND (recovery_lease_until IS NULL OR recovery_lease_until <= clock_timestamp())
    ORDER BY recovery_after ASC, updated_at ASC, request_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE agent_controller.agent_lifecycle_operations AS operation
SET recovery_owner = $2,
	    recovery_lease_until = clock_timestamp() + $1::interval,
    attempt = operation.attempt + 1
FROM candidate
WHERE operation.request_id = candidate.request_id
RETURNING operation.request_id, operation.request_fingerprint, operation.agent_id,
          operation.kind, operation.phase, operation.state,
          operation.source_spec_revision_id, operation.source_execution_revision_id,
          operation.source_runtime_revision, operation.source_runtime_absent,
          operation.target_spec_revision_id, operation.child_request_id,
          operation.network_attachment,
          operation.source_runtime_inspection, operation.source_runtime_absence_proof,
          operation.runtime_result, operation.network_release_outcome,
          operation.initial_attempt_trace_parent, operation.previous_recovery_trace_parent,
          operation.attempt, operation.recovery_owner, operation.recovery_lease_until,
          operation.recovery_after, operation.recovery_failure_count,
          operation.error_code, operation.error_detail, operation.retryable,
          operation.created_at, operation.updated_at`,
		input.LeaseDuration.String(), input.WorkerID,
	)
	operation, err := scanLifecycleOperation(row)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LifecycleRecoveryClaim{}, false, nil
	}
	if err != nil {
		return ports.LifecycleRecoveryClaim{}, false,
			fmt.Errorf("claim lifecycle recovery: %w", err)
	}
	return ports.LifecycleRecoveryClaim{
		Operation: operation, WorkerID: operation.RecoveryOwner,
		Attempt: operation.Attempt, LeaseUntil: *operation.RecoveryLeaseUntil,
		ConsecutiveFailures: operation.RecoveryFailureCount,
	}, true, nil
}

func (repository *Repository) StartLifecycleRecoveryAttempt(
	ctx context.Context, input ports.StartLifecycleRecoveryAttempt,
) error {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.WorkerID) == "" ||
		input.Attempt < 1 {
		return fmt.Errorf("invalid lifecycle recovery attempt")
	}
	result, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET previous_recovery_trace_parent = CASE
		WHEN $4 = '' THEN previous_recovery_trace_parent ELSE $4 END
WHERE request_id = $1 AND state = 'running' AND recovery_owner = $2
	AND attempt = $3 AND recovery_lease_until > clock_timestamp()`,
		input.RequestID, input.WorkerID, input.Attempt, input.TraceParent,
	)
	if err != nil {
		return fmt.Errorf("start lifecycle recovery attempt: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	return nil
}

func (repository *Repository) ReleaseLifecycleRecoveryClaim(
	ctx context.Context, input ports.ReleaseLifecycleRecoveryClaim,
) error {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.WorkerID) == "" ||
		input.Attempt < 1 || input.RetryAfter < 0 {
		return fmt.Errorf("invalid lifecycle recovery release")
	}
	result, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET recovery_owner = '', recovery_lease_until = NULL,
    recovery_after = CASE
		WHEN state = 'running' THEN clock_timestamp() + $4::interval
		ELSE clock_timestamp() END,
    recovery_failure_count = CASE
        WHEN state = 'running' AND $5 THEN recovery_failure_count + 1 ELSE 0 END
WHERE request_id = $1 AND recovery_owner = $2 AND attempt = $3
	AND recovery_lease_until > clock_timestamp()`,
		input.RequestID, input.WorkerID, input.Attempt,
		input.RetryAfter.String(), input.Failed,
	)
	if err != nil {
		return fmt.Errorf("release lifecycle recovery claim: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	return nil
}

func (repository *Repository) QuarantineLifecycleRecoveryClaim(
	ctx context.Context, input ports.QuarantineLifecycleRecoveryClaim,
) error {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.WorkerID) == "" ||
		input.Attempt < 1 || strings.TrimSpace(input.ErrorCode) == "" ||
		strings.TrimSpace(input.ErrorDetail) == "" || strings.TrimSpace(input.EventID) == "" {
		return fmt.Errorf("invalid lifecycle recovery quarantine")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin lifecycle recovery quarantine: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return err
	}
	tokenContext := ports.WithLifecycleRecoveryToken(ctx, ports.LifecycleRecoveryToken{
		RequestID: input.RequestID, WorkerID: input.WorkerID, Attempt: input.Attempt,
	})
	if operation.State != domain.OperationRunning {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	if err := authorizeLifecycleMutation(tokenContext, transaction, operation); err != nil {
		return err
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
		return ports.ErrLifecycleRecoveryClaimLost
	}
	nextSequence := aggregateSequence + 1
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET lifecycle_state = 'unavailable', active_operation_request_id = '',
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
		return ports.ErrLifecycleRecoveryClaimLost
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
    recovery_owner = '', recovery_lease_until = NULL,
    recovery_after = $4, updated_at = $4
WHERE request_id = $1`, input.RequestID, input.ErrorCode, input.ErrorDetail, now); err != nil {
		return fmt.Errorf("quarantine Agent lifecycle operation: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle recovery quarantine: %w", err)
	}
	repository.recordEventAppend(ctx, ports.EventAgentLifecycleQuarantined)
	return nil
}

var _ ports.LifecycleRecoveryStore = (*Repository)(nil)

func authorizeLifecycleMutation(
	ctx context.Context, transaction pgx.Tx, operation ports.LifecycleOperationRecord,
) error {
	token, recovered := ports.LifecycleRecoveryTokenFromContext(ctx)
	if !recovered {
		return ports.ErrConcurrentChange
	}
	if token.RequestID != operation.RequestID || token.WorkerID != operation.RecoveryOwner ||
		token.Attempt != operation.Attempt || operation.RecoveryLeaseUntil == nil {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	var valid bool
	if err := transaction.QueryRow(ctx, `
SELECT recovery_owner = $2 AND attempt = $3
       AND recovery_lease_until > clock_timestamp()
FROM agent_controller.agent_lifecycle_operations
WHERE request_id = $1`, token.RequestID, token.WorkerID, token.Attempt).Scan(&valid); err != nil {
		return fmt.Errorf("verify lifecycle recovery claim: %w", err)
	}
	if !valid {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	return nil
}

func authorizeLifecycleMutationOrReplay(
	ctx context.Context,
	transaction pgx.Tx,
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
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return false, err
	}
	return false, nil
}
