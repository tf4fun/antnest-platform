package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ClaimLifecycleRecovery(
	ctx context.Context, input ports.ClaimLifecycleRecovery,
) (ports.LifecycleRecoveryClaim, bool, error) {
	if strings.TrimSpace(input.WorkerID) == "" || input.StaleAfter <= 0 ||
		input.LeaseDuration <= 0 {
		return ports.LifecycleRecoveryClaim{}, false, fmt.Errorf("invalid lifecycle recovery claim")
	}
	row := repository.pool.QueryRow(ctx, `
WITH candidate AS (
    SELECT request_id
    FROM agent_controller.agent_lifecycle_operations
    WHERE state = 'running'
      AND (attempt > 1 OR created_at <= clock_timestamp() - $1::interval)
      AND recovery_after <= clock_timestamp()
      AND (recovery_lease_until IS NULL OR recovery_lease_until <= clock_timestamp())
    ORDER BY recovery_after ASC, updated_at ASC, request_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE agent_controller.agent_lifecycle_operations AS operation
SET recovery_owner = $3,
    recovery_lease_until = clock_timestamp() + $2::interval,
    attempt = operation.attempt + 1
FROM candidate
WHERE operation.request_id = candidate.request_id
RETURNING operation.request_id, operation.request_fingerprint, operation.agent_id,
          operation.kind, operation.phase, operation.state,
          operation.source_spec_revision_id, operation.source_execution_revision_id,
          operation.source_runtime_revision, operation.source_runtime_absent,
          operation.target_spec_revision_id, operation.child_request_id,
          operation.network_attachment, operation.network_policy_assignment,
          operation.source_runtime_inspection, operation.source_runtime_absence_proof,
          operation.runtime_result, operation.network_release_outcome,
          operation.initial_attempt_trace_parent, operation.previous_recovery_trace_parent,
          operation.attempt, operation.recovery_owner, operation.recovery_lease_until,
          operation.recovery_after, operation.recovery_failure_count,
          operation.error_code, operation.error_detail, operation.retryable,
          operation.created_at, operation.updated_at`,
		input.StaleAfter.String(), input.LeaseDuration.String(), input.WorkerID,
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
		input.Attempt < 2 {
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
		input.Attempt < 2 || input.RetryAfter < 0 {
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

var _ ports.LifecycleRecoveryStore = (*Repository)(nil)

func authorizeLifecycleMutation(
	ctx context.Context, transaction pgx.Tx, operation ports.LifecycleOperationRecord,
) error {
	token, recovered := ports.LifecycleRecoveryTokenFromContext(ctx)
	if !recovered {
		if operation.RecoveryOwner != "" {
			return ports.ErrConcurrentChange
		}
		return nil
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
