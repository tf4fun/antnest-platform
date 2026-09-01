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

func (repository *Repository) GetAgentDeleteBase(
	ctx context.Context, agentID string,
) (ports.AgentDeleteBase, error) {
	agent, err := loadAgentRecord(ctx, repository.pool, agentID)
	if err != nil {
		return ports.AgentDeleteBase{}, err
	}
	return ports.AgentDeleteBase{Agent: agent}, nil
}

func (repository *Repository) ReplayAgentDelete(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentDeleteState, bool, error) {
	transaction, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ports.AgentDeleteState{}, false, fmt.Errorf("begin Agent delete replay: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentDeleteState{}, false, nil
	}
	if err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	if operation.Kind != domain.OperationDelete || operation.RequestFingerprint != fingerprint {
		return ports.AgentDeleteState{}, false, ports.ErrRequestConflict
	}
	state, err := loadAgentDeleteState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDeleteState{}, false, fmt.Errorf("commit Agent delete replay: %w", err)
	}
	return state, true, nil
}

func (repository *Repository) BeginAgentDelete(
	ctx context.Context, input ports.BeginAgentDelete,
) (ports.AgentDeleteState, bool, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDeleteState{}, false, fmt.Errorf("begin Agent delete transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "FOR UPDATE")
	switch {
	case err == nil:
		if existing.Kind != domain.OperationDelete ||
			existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentDeleteState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentDeleteState(ctx, transaction, existing)
		return state, true, loadErr
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentDeleteState{}, false, err
	}

	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	if !validDeleteBegin(agent, input) {
		return ports.AgentDeleteState{}, false, ports.ErrConcurrentChange
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'deleted', lifecycle_state = 'deleting',
    active_operation_request_id = $2, failure_stage = '', failure_code = '',
    failure_detail = '', aggregate_sequence = $3, updated_at = $4
WHERE id = $1 AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND desired_state = $6 AND lifecycle_state = $7 AND runtime_revision = $8`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, input.ExpectedDesiredState,
		input.ExpectedLifecycleState, input.ExpectedRuntimeRevision,
	)
	if err != nil {
		return ports.AgentDeleteState{}, false, fmt.Errorf("attach Agent delete operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentDeleteState{}, false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentDeleteState{}, false, err
	}
	agent.DesiredState = domain.DesiredDeleted
	agent.LifecycleState = domain.AgentDeleting
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.FailureStage = ""
	agent.FailureCode = ""
	agent.FailureDetail = ""
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	state := ports.AgentDeleteState{Agent: agent, Operation: input.Operation}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDeleteState{}, false, fmt.Errorf("commit Agent delete transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) SettleAgentDeleteDrain(
	ctx context.Context,
	requestID string,
	fingerprint string,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentDeleteState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("begin Agent delete drain transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return ports.AgentDeleteState{}, err
	}
	if operation.Kind != domain.OperationDelete || operation.RequestFingerprint != fingerprint {
		return ports.AgentDeleteState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhaseDrain {
		return loadAgentDeleteState(ctx, transaction, operation)
	}
	blocked, err := activeRunBlocksDrain(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if blocked {
		return loadAgentDeleteState(ctx, transaction, operation)
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, domain.PhaseDrain, domain.PhaseNetworkFence,
		nextChildRequestID, nil, nil, now,
	); err != nil {
		return ports.AgentDeleteState{}, err
	}
	return commitAgentDeleteState(ctx, transaction, requestID, "commit Agent delete drain")
}

func (repository *Repository) AdvanceAgentDelete(
	ctx context.Context, input ports.AdvanceAgentDelete,
) (ports.AgentDeleteState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("begin Agent delete phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return ports.AgentDeleteState{}, err
	}
	if operation.Kind != domain.OperationDelete || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentDeleteState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase ||
		!validDeleteAdvance(operation, input) {
		return ports.AgentDeleteState{}, ports.ErrConcurrentChange
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, input.ExpectedPhase, input.NextPhase,
		input.NextChildRequestID, input.NetworkAttachment, input.RuntimeResult, input.Now,
	); err != nil {
		return ports.AgentDeleteState{}, err
	}
	if input.ExpectedPhase == domain.PhaseNetworkRelease {
		result, updateErr := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET network_release_outcome = $2
WHERE request_id = $1 AND state = 'running' AND phase = 'publish'`,
			input.RequestID, input.NetworkReleaseOutcome,
		)
		if updateErr != nil {
			return ports.AgentDeleteState{}, fmt.Errorf("record Agent network release outcome: %w", updateErr)
		}
		if result.RowsAffected() != 1 {
			return ports.AgentDeleteState{}, ports.ErrConcurrentChange
		}
	}
	releasedRun := false
	if deleteCrossedRuntimeBarrier(operation, input) {
		releasedRun, err = repository.releaseBlockedRunAdmission(
			ctx, transaction, operation, input.RunReleaseEvent, input.Now,
		)
		if err != nil {
			return ports.AgentDeleteState{}, err
		}
	}
	state, err := commitAgentDeleteState(
		ctx, transaction, input.RequestID, "commit Agent delete phase",
	)
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	state.RunReleaseOutcome = runReleaseOutcome(deleteCrossedRuntimeBarrier(operation, input), releasedRun)
	if releasedRun {
		repository.recordEventAppend(ctx, ports.EventRunAdmissionReleased)
	}
	return state, nil
}

func (repository *Repository) PublishAgentDelete(
	ctx context.Context, input ports.PublishAgentDelete,
) (ports.AgentDeleteState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("begin Agent delete publish transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return ports.AgentDeleteState{}, err
	}
	if operation.Kind != domain.OperationDelete || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentDeleteState{}, ports.ErrRequestConflict
	}
	if operation.State == domain.OperationCompleted {
		return loadAgentDeleteState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		!deleteOperationHasPublishProof(operation) ||
		!validDeleteEvent(
			input.DeletedEvent, operation, ports.EventAgentDeleted,
			input.DeletedEvent.AggregateSequence,
		) {
		return ports.AgentDeleteState{}, ports.ErrConcurrentChange
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if agent.DesiredState != domain.DesiredDeleted || agent.LifecycleState != domain.AgentDeleting ||
		agent.ActiveOperationRequestID != operation.RequestID ||
		input.DeletedEvent.AggregateSequence != agent.AggregateSequence+1 {
		return ports.AgentDeleteState{}, ports.ErrConcurrentChange
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'deleted', lifecycle_state = 'deleted',
    executable_spec_revision_id = '', executable_execution_revision_id = '',
    runtime_revision = '', runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '',
    failure_stage = '', failure_code = '', failure_detail = '',
    aggregate_sequence = $2, updated_at = $3
WHERE id = $1 AND desired_state = 'deleted' AND lifecycle_state = 'deleting'
  AND active_operation_request_id = $4 AND aggregate_sequence = $5`,
		operation.AgentID, input.DeletedEvent.AggregateSequence, input.Now,
		operation.RequestID, agent.AggregateSequence,
	)
	if err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("publish deleted Agent projection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentDeleteState{}, ports.ErrConcurrentChange
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_access_bindings
SET active = FALSE, updated_at = $2
WHERE agent_id = $1 AND active`, operation.AgentID, input.Now); err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("deactivate deleted Agent access: %w", err)
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.DeletedEvent); err != nil {
		return ports.AgentDeleteState{}, err
	}
	completed, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    error_code = '', error_detail = '', retryable = FALSE,
    recovery_owner = '', recovery_lease_until = NULL, updated_at = $2
WHERE request_id = $1 AND state = 'running' AND phase = 'publish'`,
		operation.RequestID, input.Now,
	)
	if err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("complete Agent delete operation: %w", err)
	}
	if completed.RowsAffected() != 1 {
		return ports.AgentDeleteState{}, ports.ErrConcurrentChange
	}
	state, err := commitAgentDeleteState(ctx, transaction, input.RequestID, "commit Agent delete publish")
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	repository.recordEventAppend(ctx, input.DeletedEvent.EventType)
	return state, nil
}

func validDeleteBegin(agent ports.AgentRecord, input ports.BeginAgentDelete) bool {
	operation := input.Operation
	return agent.AgentID == input.AgentID && agent.ActiveOperationRequestID == "" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		agent.DesiredState == input.ExpectedDesiredState &&
		agent.LifecycleState == input.ExpectedLifecycleState &&
		agent.RuntimeRevision == input.ExpectedRuntimeRevision &&
		operation.AgentID == input.AgentID && operation.Kind == domain.OperationDelete &&
		operation.State == domain.OperationRunning && operation.Phase == domain.PhaseDrain &&
		validDeleteRuntimeSource(agent, operation) &&
		operation.SourceSpecRevisionID == "" && operation.SourceExecutionRevisionID == "" &&
		operation.TargetSpecRevisionID == "" &&
		validDeleteEvent(
			input.RequestedEvent, operation, ports.EventAgentDeleteRequested,
			agent.AggregateSequence+1,
		)
}

func validDeleteAdvance(
	operation ports.LifecycleOperationRecord, input ports.AdvanceAgentDelete,
) bool {
	if input.NextChildRequestID != domain.ChildRequestID(input.RequestID, input.NextPhase) {
		return false
	}
	switch input.ExpectedPhase {
	case domain.PhaseNetworkFence:
		return input.NextPhase == domain.PhaseFlowReset &&
			input.NetworkAttachment == nil && input.RuntimeResult == nil &&
			input.NetworkReleaseOutcome == "" && emptyRunAdmissionEvent(input.RunReleaseEvent)
	case domain.PhaseFlowReset:
		next := domain.PhaseRuntimeDelete
		if operation.SourceRuntimeAbsent {
			next = domain.PhaseNetworkRelease
		}
		validReleaseEvent := emptyRunAdmissionEvent(input.RunReleaseEvent)
		if operation.SourceRuntimeAbsent {
			validReleaseEvent = validRunEvent(input.RunReleaseEvent, domain.AdmissionReleased)
		}
		return input.NextPhase == next && input.NetworkAttachment == nil &&
			input.RuntimeResult == nil && input.NetworkReleaseOutcome == "" && validReleaseEvent
	case domain.PhaseRuntimeDelete:
		return !operation.SourceRuntimeAbsent && input.NextPhase == domain.PhaseNetworkRelease &&
			input.NetworkAttachment == nil && input.RuntimeResult != nil &&
			input.NetworkReleaseOutcome == "" && deletedRuntimeResult(*input.RuntimeResult) &&
			validRunEvent(input.RunReleaseEvent, domain.AdmissionReleased)
	case domain.PhaseNetworkRelease:
		return input.NextPhase == domain.PhasePublish && input.RuntimeResult == nil &&
			validDeleteNetworkReleaseInput(operation.AgentID, input) &&
			emptyRunAdmissionEvent(input.RunReleaseEvent)
	default:
		return false
	}
}

func validDeleteRuntimeSource(
	agent ports.AgentRecord, operation ports.LifecycleOperationRecord,
) bool {
	if agent.RuntimeRevision != "" {
		return operation.SourceRuntimeRevision == agent.RuntimeRevision &&
			!operation.SourceRuntimeAbsent && operation.SourceRuntimeInspection == nil &&
			operation.SourceRuntimeAbsenceProof == nil
	}
	if operation.SourceRuntimeAbsent {
		return operation.SourceRuntimeRevision == "" && operation.SourceRuntimeInspection == nil &&
			validRuntimeAbsenceProof(operation.SourceRuntimeAbsenceProof)
	}
	inspection := operation.SourceRuntimeInspection
	return operation.SourceRuntimeAbsenceProof == nil && operation.SourceRuntimeRevision != "" &&
		inspection != nil && inspection.AgentID == agent.AgentID &&
		inspection.RuntimeRevision == operation.SourceRuntimeRevision &&
		(inspection.LifecycleState != "deleted" || inspection.Health != "absent")
}

func validRuntimeAbsenceProof(proof *ports.RuntimeAbsenceProof) bool {
	if proof == nil || proof.ObservedAt.IsZero() {
		return false
	}
	switch proof.Reason {
	case "runtime_not_found":
		return proof.RuntimeRevision == ""
	case "runtime_deleted":
		return proof.RuntimeRevision != ""
	default:
		return false
	}
}

func validDeleteNetworkReleaseInput(agentID string, input ports.AdvanceAgentDelete) bool {
	switch input.NetworkReleaseOutcome {
	case ports.NetworkReleaseQuarantined:
		return input.NetworkAttachment != nil && input.NetworkAttachment.AgentID == agentID &&
			input.NetworkAttachment.State == "quarantined"
	case ports.NetworkReleaseAuthoritativeNone:
		return input.NetworkAttachment == nil
	default:
		return false
	}
}

func deleteOperationHasPublishProof(operation ports.LifecycleOperationRecord) bool {
	runtimeProven := operation.SourceRuntimeAbsent &&
		validRuntimeAbsenceProof(operation.SourceRuntimeAbsenceProof)
	if !operation.SourceRuntimeAbsent {
		runtimeProven = operation.RuntimeResult != nil && deletedRuntimeResult(*operation.RuntimeResult)
	}
	if !runtimeProven {
		return false
	}
	switch operation.NetworkReleaseOutcome {
	case ports.NetworkReleaseQuarantined:
		return operation.NetworkAttachment != nil &&
			operation.NetworkAttachment.AgentID == operation.AgentID &&
			operation.NetworkAttachment.State == "quarantined"
	case ports.NetworkReleaseAuthoritativeNone:
		return operation.NetworkAttachment == nil
	default:
		return false
	}
}

func deleteCrossedRuntimeBarrier(
	operation ports.LifecycleOperationRecord, input ports.AdvanceAgentDelete,
) bool {
	return input.ExpectedPhase == domain.PhaseRuntimeDelete ||
		(operation.SourceRuntimeAbsent && input.ExpectedPhase == domain.PhaseFlowReset)
}

func activeRunBlocksDrain(ctx context.Context, transaction pgx.Tx, agentID string) (bool, error) {
	var admissionState string
	err := transaction.QueryRow(ctx, `
SELECT state FROM agent_controller.run_admissions
WHERE agent_id = $1 AND state IN ('active', 'blocked_unknown_effect')
ORDER BY admission_id LIMIT 1 FOR UPDATE`, agentID).Scan(&admissionState)
	switch {
	case err == nil && admissionState == "active":
		return true, nil
	case err == nil && admissionState == "blocked_unknown_effect":
		return false, nil
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("inspect Agent delete occupancy: %w", err)
	default:
		return false, fmt.Errorf("unsupported Run admission state %q", admissionState)
	}
}

func deletedRuntimeResult(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "deleted" && result.Health == "absent" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}

func validDeleteEvent(
	event ports.AgentEventRecord,
	operation ports.LifecycleOperationRecord,
	eventType string,
	aggregateSequence int64,
) bool {
	return event.EventID != "" && event.AgentID == operation.AgentID &&
		event.AggregateSequence == aggregateSequence && event.SchemaVersion == 1 &&
		event.EventType == eventType && event.OperationRequestID == operation.RequestID &&
		event.Data != nil && !event.OccurredAt.IsZero()
}

func loadAgentDeleteState(
	ctx context.Context,
	queryer catalogQueryer,
	operation ports.LifecycleOperationRecord,
) (ports.AgentDeleteState, error) {
	agent, err := loadAgentRecord(ctx, queryer, operation.AgentID)
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	return ports.AgentDeleteState{Agent: agent, Operation: operation}, nil
}

func commitAgentDeleteState(
	ctx context.Context, transaction pgx.Tx, requestID string, action string,
) (ports.AgentDeleteState, error) {
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	state, err := loadAgentDeleteState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDeleteState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDeleteState{}, fmt.Errorf("%s: %w", action, err)
	}
	return state, nil
}
