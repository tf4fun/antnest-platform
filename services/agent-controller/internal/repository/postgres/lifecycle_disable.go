package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ReplayAgentDisable(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentDisableState, bool, error) {
	transaction, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ports.AgentDisableState{}, false, fmt.Errorf("begin Agent disable replay: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentDisableState{}, false, nil
	}
	if err != nil {
		return ports.AgentDisableState{}, false, err
	}
	if operation.Kind != domain.OperationDisable || operation.RequestFingerprint != fingerprint {
		return ports.AgentDisableState{}, false, ports.ErrRequestConflict
	}
	state, err := loadAgentDisableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDisableState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDisableState{}, false, fmt.Errorf("commit Agent disable replay: %w", err)
	}
	return state, true, nil
}

func (repository *Repository) BeginAgentDisable(
	ctx context.Context, input ports.BeginAgentDisable,
) (ports.AgentDisableState, bool, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDisableState{}, false, fmt.Errorf("begin Agent disable transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentDisableState{}, false, err
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "")
	switch {
	case err == nil:
		if existing.Kind != domain.OperationDisable ||
			existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentDisableState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentDisableState(ctx, transaction, existing)
		return state, true, loadErr
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentDisableState{}, false, err
	}

	if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
		return ports.AgentDisableState{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentDisableState{}, false, err
	}
	if !matchesDisableSource(agent, input) {
		return ports.AgentDisableState{}, false, ports.ErrConcurrentChange
	}
	if input.Operation.OwnerRevocationSequence > 0 && (!agent.IdentityRevoked() || agent.IdentityRevocationSequence != input.Operation.OwnerRevocationSequence) {
		return ports.AgentDisableState{}, false, ports.ErrConcurrentChange
	}
	sourceSpec, err := loadAgentSpec(ctx, transaction, input.ExpectedSpecRevisionID)
	if err != nil {
		return ports.AgentDisableState{}, false, err
	}
	sourceExecution, err := loadOptionalExecutionRevision(
		ctx, transaction, input.ExpectedExecutionRevisionID,
	)
	if err != nil {
		return ports.AgentDisableState{}, false, err
	}
	if !validDisableBegin(input, agent, sourceSpec, sourceExecution) {
		return ports.AgentDisableState{}, false, ports.ErrConcurrentChange
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentDisableState{}, false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'disabled', active_operation_request_id = $2,
    aggregate_sequence = $3, updated_at = $4
WHERE id = $1 AND (desired_state = 'enabled' OR (desired_state = 'disabled' AND identity_revocation_sequence > owner_authorization_sequence)) AND lifecycle_state = 'created' AND activation_state = 'enabled'
  AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND executable_spec_revision_id = $6
  AND executable_execution_revision_id = $7 AND runtime_revision = $8`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, input.ExpectedSpecRevisionID,
		agent.ExecutionRevisionID, input.ExpectedRuntimeRevision,
	)
	if err != nil {
		return ports.AgentDisableState{}, false, fmt.Errorf("attach Agent disable operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentDisableState{}, false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentDisableState{}, false, err
	}
	agent.DesiredState = domain.DesiredDisabled
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	state := ports.AgentDisableState{
		Agent: agent, SourceSpec: sourceSpec,
		SourceExecution: sourceExecution, Operation: input.Operation,
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, agent.OrganizationID); err != nil {
		return ports.AgentDisableState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDisableState{}, false, fmt.Errorf("commit Agent disable transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) AdvanceAgentDisable(
	ctx context.Context, input ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	if err := validateDisableAdvance(input); err != nil {
		return ports.AgentDisableState{}, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("begin Agent disable phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if operation.Kind != domain.OperationDisable || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentDisableState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, input.ExpectedPhase, input.NextPhase,
		input.NextChildRequestID, input.NetworkAttachment, input.RuntimeResult, input.Now,
	); err != nil {
		return ports.AgentDisableState{}, err
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	state, err := loadAgentDisableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("commit Agent disable phase: %w", err)
	}
	return state, nil
}

func (repository *Repository) PublishAgentDisable(
	ctx context.Context, input ports.PublishAgentDisable,
) (ports.AgentDisableState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("begin Agent disable publish transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationDisable, input.Fingerprint, domain.OperationCompleted,
	)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if replayed {
		return loadAgentDisableState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		operation.RuntimeResult == nil || operation.NetworkAttachment == nil ||
		operation.NetworkAttachment.AttachmentState != ports.NetworkAttachmentClosed ||
		!disabledRuntimeResult(*operation.RuntimeResult) {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	state, err := loadAgentDisableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if input.DisabledEvent.AggregateSequence != state.Agent.AggregateSequence+1 {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'disabled', activation_state = 'disabled', runtime_state = 'absent',
    runtime_reason = '', runtime_detail = '', runtime_observed_at = $6,
    executable_spec_revision_id = $2, executable_execution_revision_id = '',
    runtime_revision = $4, runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '', failure_stage = '', failure_code = '', failure_detail = '',
    aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND desired_state = 'disabled' AND lifecycle_state = 'created' AND activation_state = 'enabled'
  AND active_operation_request_id = $7 AND aggregate_sequence = $8
  AND executable_spec_revision_id = $2
  AND executable_execution_revision_id = $3 AND runtime_revision = $9`,
		operation.AgentID, state.SourceSpec.ID, state.Agent.ExecutionRevisionID,
		operation.RuntimeResult.RuntimeRevision, input.DisabledEvent.AggregateSequence,
		input.Now, input.RequestID, input.DisabledEvent.AggregateSequence-1,
		operation.SourceRuntimeRevision,
	)
	if err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("publish disabled Agent projection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.DisabledEvent); err != nil {
		return ports.AgentDisableState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    error_code = '', error_detail = '', retryable = FALSE,
    updated_at = $2
WHERE request_id = $1`, input.RequestID, input.Now); err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("complete Agent disable operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	state, err = loadAgentDisableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentDisableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("commit Agent disable publish: %w", err)
	}
	repository.recordEventAppend(ctx, input.DisabledEvent.EventType)
	return state, nil
}

func (repository *Repository) FailAgentDisable(
	ctx context.Context, input ports.FailAgentDisable,
) (ports.AgentDisableState, error) {
	var inspectionPayload, absenceProofPayload []byte
	var err error
	if input.SourceRuntimeInspection != nil {
		inspectionPayload, err = json.Marshal(input.SourceRuntimeInspection)
		if err != nil {
			return ports.AgentDisableState{}, fmt.Errorf("encode source Runtime inspection: %w", err)
		}
	}
	if input.RuntimeAbsenceProof != nil {
		absenceProofPayload, err = json.Marshal(input.RuntimeAbsenceProof)
		if err != nil {
			return ports.AgentDisableState{}, fmt.Errorf("encode Runtime absence proof: %w", err)
		}
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("begin Agent disable failure transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationDisable, input.Fingerprint, domain.OperationFailed,
	)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if replayed {
		return loadAgentDisableState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.Stage {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if input.ExpectedAggregateSequence != agent.AggregateSequence ||
		input.FailedEvent.AggregateSequence != 0 {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	if input.RuntimeAbsenceProof != nil &&
		(input.PreserveExecutable || input.SourceRuntimeInspection != nil ||
			operation.Phase != domain.PhaseRuntimeDisable ||
			!validRuntimeRemovalProof(operation, input.RuntimeAbsenceProof, input.Now)) {
		return ports.AgentDisableState{}, fmt.Errorf("invalid disable Runtime absence failure")
	}
	failedEvent := input.FailedEvent
	failedEvent.AggregateSequence = agent.AggregateSequence + 1
	var result pgconn.CommandTag
	if input.PreserveExecutable {
		result, err = transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = CASE WHEN identity_revocation_sequence > owner_authorization_sequence OR $12 > 0 THEN 'disabled' ELSE 'enabled' END,
    runtime_state = 'unknown', runtime_reason = 'runtime_recheck_required', runtime_detail = '', runtime_observed_at = $6,
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND desired_state = 'disabled' AND lifecycle_state = 'created' AND activation_state = 'enabled'
  AND active_operation_request_id = $7 AND aggregate_sequence = $8
  AND executable_spec_revision_id = $9
  AND executable_execution_revision_id = $10 AND runtime_revision = $11`,
			operation.AgentID, input.Stage, input.Code, input.Detail,
			failedEvent.AggregateSequence, input.Now, input.RequestID,
			failedEvent.AggregateSequence-1, operation.SourceSpecRevisionID,
			agent.ExecutionRevisionID, operation.SourceRuntimeRevision,
			operation.OwnerRevocationSequence,
		)
	} else {
		result, err = transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'disabled', runtime_state = 'unknown', runtime_reason = 'disable_failed', runtime_observed_at = NULL,
    executable_execution_revision_id = '',
    runtime_revision = '', runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND desired_state = 'disabled' AND lifecycle_state = 'created' AND activation_state = 'enabled'
  AND active_operation_request_id = $7 AND aggregate_sequence = $8
  AND executable_spec_revision_id = $9
  AND executable_execution_revision_id = $10 AND runtime_revision = $11`,
			operation.AgentID, input.Stage, input.Code, input.Detail,
			failedEvent.AggregateSequence, input.Now, input.RequestID,
			failedEvent.AggregateSequence-1, operation.SourceSpecRevisionID,
			agent.ExecutionRevisionID, operation.SourceRuntimeRevision,
		)
	}
	if err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("project Agent disable failure: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentDisableState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, failedEvent); err != nil {
		return ports.AgentDisableState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = FALSE, source_runtime_inspection = $4,
    source_runtime_absence_proof = $5,
    updated_at = $6
WHERE request_id = $1`, input.RequestID, input.Code, input.Detail,
		nullJSON(inspectionPayload), nullJSON(absenceProofPayload), input.Now); err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("fail Agent disable operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	state, err := loadAgentDisableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentDisableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentDisableState{}, fmt.Errorf("commit Agent disable failure: %w", err)
	}
	repository.recordEventAppend(ctx, input.FailedEvent.EventType)
	return state, nil
}

func validDisableBegin(
	input ports.BeginAgentDisable,
	agent ports.AgentRecord,
	spec ports.AgentSpecRecord,
	execution ports.ExecutionRecord,
) bool {
	return input.Operation.Kind == domain.OperationDisable &&
		input.Operation.AgentID == input.AgentID &&
		input.Operation.SourceSpecRevisionID == input.ExpectedSpecRevisionID &&
		input.Operation.SourceExecutionRevisionID == input.ExpectedExecutionRevisionID &&
		input.Operation.SourceRuntimeRevision == input.ExpectedRuntimeRevision &&
		input.Operation.TargetSpecRevisionID == "" &&
		input.RequestedEvent.AgentID == input.AgentID &&
		input.RequestedEvent.AggregateSequence == agent.AggregateSequence+1 &&
		(ports.AgentRuntimeSource{Spec: spec, Execution: execution}).MatchesAgent(agent)
}

func validateDisableAdvance(input ports.AdvanceAgentDisable) error {
	valid := false
	switch {
	case input.ExpectedPhase == domain.PhaseNetworkFence &&
		input.NextPhase == domain.PhaseRuntimeDisable:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil
	case input.ExpectedPhase == domain.PhaseRuntimeDisable &&
		input.NextPhase == domain.PhasePublish:
		valid = input.NetworkAttachment == nil && input.RuntimeResult != nil &&
			disabledRuntimeResult(*input.RuntimeResult)
	}
	if !valid || input.RequestID == "" || input.Fingerprint == "" ||
		input.NextChildRequestID == "" || input.Now.IsZero() {
		return fmt.Errorf("invalid Agent disable phase transition")
	}
	return nil
}

func disabledRuntimeResult(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "disabled" && result.Health == "absent" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}

func matchesDisableSource(agent ports.AgentRecord, input ports.BeginAgentDisable) bool {
	return agent.AllowsDisableRequest() &&
		agent.HasConfiguredRuntime() && agent.ActiveOperationRequestID == "" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		agent.AgentSpecRevisionID == input.ExpectedSpecRevisionID &&
		(agent.ExecutionRevisionID == input.ExpectedExecutionRevisionID ||
			(agent.ExecutionRevisionID == "" && agent.LastSuccessfulExecutionRevisionID == input.ExpectedExecutionRevisionID)) &&
		agent.RuntimeRevision == input.ExpectedRuntimeRevision
}

func loadAgentDisableState(
	ctx context.Context, queryer catalogQueryer, operation ports.LifecycleOperationRecord,
) (ports.AgentDisableState, error) {
	agent, err := loadAgentRecord(ctx, queryer, operation.AgentID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	sourceSpec, err := loadAgentSpec(ctx, queryer, operation.SourceSpecRevisionID)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	sourceExecution, err := loadOptionalExecutionRevision(
		ctx, queryer, operation.SourceExecutionRevisionID,
	)
	if err != nil {
		return ports.AgentDisableState{}, err
	}
	return ports.AgentDisableState{
		Agent: agent, SourceSpec: sourceSpec,
		SourceExecution: sourceExecution, Operation: operation,
	}, nil
}
