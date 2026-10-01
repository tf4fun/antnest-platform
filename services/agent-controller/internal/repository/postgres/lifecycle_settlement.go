package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ConfirmLifecycleDrain(ctx context.Context, input ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	if !validDrainConfirmation(input) {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("invalid lifecycle drain confirmation")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if operation.Kind != input.Kind || operation.RequestFingerprint != input.Fingerprint {
		return ports.LifecycleOperationRecord{}, ports.ErrRequestConflict
	}
	if operation.SettlementOutcome != "" {
		if operation.SettlementOutcome != input.Outcome {
			return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
		}
		return operation, nil
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhaseDrain || operation.DrainDeadlineAt == nil {
		return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
	}
	if !input.Now.Before(*operation.DrainDeadlineAt) || !time.Now().Before(*operation.DrainDeadlineAt) {
		return ports.LifecycleOperationRecord{}, context.DeadlineExceeded
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations AS operation
SET phase = 'network_fence', child_request_id = $2, settlement_outcome = $3, updated_at = $4
WHERE request_id = $1 AND state = 'running' AND phase = 'drain'
  AND drain_deadline_at > clock_timestamp()
  AND EXISTS (SELECT 1 FROM agent_controller.agents AS agent
              WHERE agent.id = operation.agent_id AND agent.active_operation_request_id = operation.request_id)`,
		input.RequestID, domain.ChildRequestID(input.RequestID, domain.PhaseNetworkFence), input.Outcome, input.Now)
	if err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("confirm lifecycle drain: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	return operation, nil
}

func validDrainConfirmation(input ports.ConfirmLifecycleDrain) bool {
	validKind := input.Kind == domain.OperationRebuild || input.Kind == domain.OperationDisable || input.Kind == domain.OperationDelete
	validOutcome := input.Outcome == ports.ExecutionSettled || input.Outcome == ports.ExecutionRuntimeBarrierRequired
	return validKind && validOutcome && input.RequestID != "" && input.Fingerprint != "" && !input.Now.IsZero()
}
