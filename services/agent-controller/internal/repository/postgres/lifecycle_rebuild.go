package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetAgentLifecycleBase(
	ctx context.Context, agentID string,
) (ports.AgentLifecycleBase, error) {
	agent, err := loadAgentRecord(ctx, repository.pool, agentID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	nextSpec, nextExecution, err := loadNextLifecycleRevisions(ctx, repository.pool, agentID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	base := ports.AgentLifecycleBase{
		Agent: agent, NextSpecRevision: nextSpec, NextExecutionRevision: nextExecution,
	}
	failedCreate, err := loadFailedCreateRebuildSource(ctx, repository.pool, agent)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	if failedCreate != nil {
		base.FailedCreateOperation = failedCreate
		if agent.AgentSpecRevisionID != "" && agent.AgentSpecRevisionID != failedCreate.TargetSpecRevisionID {
			return ports.AgentLifecycleBase{}, ports.ErrConcurrentChange
		}
		base.ConfiguredSpec, err = loadAgentSpec(ctx, repository.pool, failedCreate.TargetSpecRevisionID)
		if err != nil {
			return ports.AgentLifecycleBase{}, err
		}
		return base, nil
	}
	if agent.AgentSpecRevisionID == "" {
		return base, nil
	}
	base.ConfiguredSpec, err = loadAgentSpec(ctx, repository.pool, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	base.SourceExecution, err = loadOptionalExecutionRevision(ctx, repository.pool, agent.ExecutionRevisionID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	if agent.ExecutionRevisionID == "" && agent.LastSuccessfulExecutionRevisionID != "" {
		history, err := loadExecutionRevision(ctx, repository.pool, agent.LastSuccessfulExecutionRevisionID)
		if err != nil {
			return ports.AgentLifecycleBase{}, err
		}
		if history.AgentID != agent.AgentID {
			return ports.AgentLifecycleBase{}, ports.ErrConcurrentChange
		}
		if history.AgentSpecRevisionID == base.ConfiguredSpec.ID &&
			history.RuntimeRevision == agent.RuntimeRevision {
			base.SourceExecution = history
		}
	}
	return base, nil
}

func (repository *Repository) ReplayAgentRebuild(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentRebuildState, bool, error) {
	transaction, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("begin Agent rebuild replay: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentRebuildState{}, false, nil
	}
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if operation.Kind != domain.OperationRebuild || operation.RequestFingerprint != fingerprint {
		return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("commit Agent rebuild replay: %w", err)
	}
	return state, true, nil
}

func (repository *Repository) BeginAgentRebuild(
	ctx context.Context, input ports.BeginAgentRebuild,
) (ports.AgentRebuildState, bool, error) {
	if err := validateRuntimeBarrierRecovery(input); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("begin Agent rebuild transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if input.Recovery != nil {
		fact := input.Recovery.Fact
		receipt, found, err := readRuntimeBarrierRecovery(ctx, transaction, fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		if found {
			// Replay the committed original before inspecting current policy,
			// owner, Template, cooldown or lifecycle state.
			if receipt.Command != input.Recovery.Command || receipt.RequestFingerprint != input.Operation.RequestFingerprint {
				return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
			}
			operation, err := loadLifecycleOperation(ctx, transaction, receipt.Command.RequestID, "")
			if err != nil {
				return ports.AgentRebuildState{}, false, err
			}
			if operation.Kind != domain.OperationRebuild || operation.AgentID != receipt.Command.AgentID || operation.RequestFingerprint != receipt.RequestFingerprint {
				return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
			}
			state, err := loadAgentRebuildState(ctx, transaction, operation)
			return state, err == nil, err
		}
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "")
	switch {
	case err == nil:
		// An ordinary operation cannot be retrofitted into a recovery receipt.
		if input.Recovery != nil || existing.Kind != domain.OperationRebuild ||
			existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentRebuildState(ctx, transaction, existing)
		if loadErr != nil {
			return ports.AgentRebuildState{}, false, loadErr
		}
		return state, true, nil
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentRebuildState{}, false, err
	}
	var recoveryPolicy domain.RuntimeBarrierRecoveryPolicy
	if input.Recovery != nil {
		recoveryPolicy, err = lockRuntimeBarrierRecoveryPolicy(ctx, transaction, input.Recovery)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		// Revocation also locks Identity before the execution organization.
		if err := lockIdentityAdmission(ctx, transaction); err != nil {
			return ports.AgentRebuildState{}, false, err
		}
	}
	if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	marker := input.Operation.SourceFailedCreateRequestID
	if marker != "" && input.Recovery != nil {
		return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
	}
	var sourceSpec ports.AgentSpecRecord
	var sourceExecution ports.ExecutionRecord
	if marker != "" {
		if !failedCreateRebuildMatches(agent, input) ||
			input.ExpectedExecutionRevisionID != "" || input.ExpectedRuntimeRevision != "" ||
			input.Operation.SourceSpecRevisionID != input.ExpectedSpecRevisionID ||
			input.Operation.SourceRuntimeRevision != "" ||
			input.Operation.SourceExecutionRevisionID != "" ||
			input.Operation.SourceRuntimeAbsent {
			return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
		}
		failedCreate, err := loadFailedCreateRebuildSource(ctx, transaction, agent)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		if failedCreate == nil || failedCreate.RequestID != marker ||
			failedCreate.TargetSpecRevisionID != input.ExpectedSpecRevisionID {
			return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
		}
		sourceSpec, err = loadAgentSpec(ctx, transaction, input.ExpectedSpecRevisionID)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		if sourceSpec.AgentID != agent.AgentID {
			return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
		}
	} else {
		if !matchesRebuildSource(agent, input) {
			return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
		}
		sourceSpec, err = loadAgentSpec(ctx, transaction, input.ExpectedSpecRevisionID)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		sourceExecution, err = loadOptionalExecutionRevision(
			ctx, transaction, input.ExpectedExecutionRevisionID,
		)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
		if !(ports.AgentRuntimeSource{Spec: sourceSpec, Execution: sourceExecution}).MatchesAgent(agent) {
			return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
		}
	}
	if input.Recovery != nil {
		if err := guardRuntimeBarrierRecovery(ctx, transaction, input, agent, sourceSpec); err != nil {
			return ports.AgentRebuildState{}, false, err
		}
	}
	nextSpec, _, err := loadNextLifecycleRevisions(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if input.TargetSpec.AgentID != input.AgentID || input.TargetSpec.Revision != nextSpec ||
		input.Operation.SourceSpecRevisionID != input.ExpectedSpecRevisionID ||
		input.Operation.SourceExecutionRevisionID != input.ExpectedExecutionRevisionID ||
		input.Operation.SourceRuntimeRevision != input.ExpectedRuntimeRevision ||
		input.Operation.TargetSpecRevisionID != input.TargetSpec.ID ||
		input.RequestedEvent.AggregateSequence != agent.AggregateSequence+1 {
		return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
	}
	if err := requireEnabledTemplateSpec(ctx, transaction, agent.OrganizationID, input.TargetSpec.Snapshot); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	var recoveryReceipt ports.RuntimeBarrierRecoveryReceipt
	if input.Recovery != nil {
		recoveryReceipt, err = freezeRuntimeBarrierRecoveryTime(ctx, transaction, &input, recoveryPolicy)
		if err != nil {
			return ports.AgentRebuildState{}, false, err
		}
	}
	if err := insertAgentSpec(ctx, transaction, input.TargetSpec); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	var acceptedAt *time.Time
	if input.Recovery != nil {
		acceptedAt = &recoveryReceipt.AcceptedAt
	}
	if err := insertLifecycleOperationAt(ctx, transaction, input.Operation, acceptedAt); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	// The validated logical source may come from a failed create's target.
	// Compare the actual locked pointer for legacy Agents whose stored spec is blank.
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET active_operation_request_id = $2, aggregate_sequence = $3, updated_at = $4
WHERE id = $1 AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND desired_state = 'enabled' AND lifecycle_state = $9
  AND executable_spec_revision_id = $6
  AND executable_execution_revision_id = $7 AND runtime_revision = $8
  AND last_successful_execution_revision_id = $10`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, agent.AgentSpecRevisionID,
		agent.ExecutionRevisionID, input.ExpectedRuntimeRevision,
		agent.LifecycleState, agent.LastSuccessfulExecutionRevisionID,
	)
	if err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("attach Agent rebuild operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	state := ports.AgentRebuildState{
		Agent: agent, SourceSpec: sourceSpec, SourceExecution: sourceExecution,
		TargetSpec: input.TargetSpec, Operation: input.Operation,
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, agent.OrganizationID); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if input.Recovery != nil {
		if err := insertRuntimeBarrierRecovery(ctx, transaction, recoveryReceipt); err != nil {
			return ports.AgentRebuildState{}, false, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("commit Agent rebuild transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) AdvanceAgentRebuild(
	ctx context.Context, input ports.AdvanceAgentRebuild,
) (ports.LifecycleAdvanceResult, error) {
	if err := validateRebuildAdvance(input); err != nil {
		return ports.LifecycleAdvanceResult{}, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LifecycleAdvanceResult{}, fmt.Errorf("begin Agent rebuild phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.LifecycleAdvanceResult{}, err
	}
	if operation.Kind != domain.OperationRebuild || operation.RequestFingerprint != input.Fingerprint {
		return ports.LifecycleAdvanceResult{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase {
		return ports.LifecycleAdvanceResult{}, ports.ErrConcurrentChange
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, input.ExpectedPhase, input.NextPhase,
		input.NextChildRequestID, input.NetworkAttachment, input.RuntimeResult, input.Now,
	); err != nil {
		return ports.LifecycleAdvanceResult{}, err
	}
	if input.ExpectedPhase == domain.PhaseRuntimeUpdate &&
		(!provisionedRuntimeResult(*input.RuntimeResult) || input.RuntimeResult.RuntimeRevision == operation.SourceRuntimeRevision) {
		return ports.LifecycleAdvanceResult{}, fmt.Errorf("invalid rebuilt Runtime result")
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.LifecycleAdvanceResult{}, err
	}
	agent, err := loadAgentRecord(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.LifecycleAdvanceResult{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.LifecycleAdvanceResult{}, fmt.Errorf("commit Agent rebuild phase: %w", err)
	}
	state := ports.LifecycleAdvanceResult{Agent: agent, Operation: operation}
	return state, nil
}

func (repository *Repository) PublishAgentRebuild(
	ctx context.Context, input ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("begin Agent rebuild publish transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationRebuild, input.Fingerprint, domain.OperationCompleted,
	)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if replayed {
		return loadAgentRebuildState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		operation.RuntimeResult == nil || operation.NetworkAttachment == nil ||
		operation.NetworkAttachment.AttachmentState != ports.NetworkAttachmentOpen ||
		input.AccessRevision == "" {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if input.RebuiltEvent.AggregateSequence != state.Agent.AggregateSequence+1 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if err := publishRuntimeTarget(ctx, transaction, operation, input.RebuiltEvent, input.Now); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if _, err := transaction.Exec(ctx, `UPDATE agent_controller.agents SET access_revision = $2 WHERE id = $1`,
		operation.AgentID, input.AccessRevision); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("update rebuilt Agent access revision: %w", err)
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_access_bindings
SET access_revision = $2, updated_at = $3
WHERE agent_id = $1 AND active = TRUE`, operation.AgentID, input.AccessRevision,
		input.Now,
	)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("update rebuilt Agent access: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RebuiltEvent); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    error_code = '', error_detail = '', retryable = FALSE,
    updated_at = $2
WHERE request_id = $1`, input.RequestID, input.Now); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("complete Agent rebuild operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	state, err = loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("commit Agent rebuild publish: %w", err)
	}
	repository.recordEventAppend(ctx, input.RebuiltEvent.EventType)
	return state, nil
}

func (repository *Repository) FailAgentRebuild(
	ctx context.Context, input ports.FailAgentRebuild,
) (ports.AgentRebuildState, error) {
	var absenceProofPayload []byte
	var err error
	if input.RuntimeAbsenceProof != nil {
		absenceProofPayload, err = json.Marshal(input.RuntimeAbsenceProof)
		if err != nil {
			return ports.AgentRebuildState{}, fmt.Errorf("encode Runtime absence proof: %w", err)
		}
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("begin Agent rebuild failure transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationRebuild, input.Fingerprint, domain.OperationFailed,
	)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if replayed {
		return loadAgentRebuildState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.Stage {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if input.ExpectedAggregateSequence != agent.AggregateSequence ||
		input.FailedEvent.AggregateSequence != 0 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if input.RuntimeAbsenceProof != nil &&
		(input.PreserveExecutable || operation.Phase != domain.PhaseRuntimeUpdate ||
			!validRuntimeRemovalProof(operation, input.RuntimeAbsenceProof, input.Now)) {
		return ports.AgentRebuildState{}, fmt.Errorf("invalid rebuild Runtime absence failure")
	}
	failedEvent := input.FailedEvent
	failedEvent.AggregateSequence = agent.AggregateSequence + 1
	query := `
UPDATE agent_controller.agents
SET runtime_state = 'unknown', runtime_reason = 'rebuild_failed', runtime_detail = '', runtime_observed_at = NULL,
    executable_execution_revision_id = '', runtime_revision = '',
    runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND active_operation_request_id = $7 AND aggregate_sequence = $8`
	if input.PreserveExecutable {
		query = `
UPDATE agent_controller.agents
SET active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    runtime_state = 'unknown', runtime_reason = 'runtime_recheck_required', runtime_detail = '', runtime_observed_at = $6,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND active_operation_request_id = $7 AND aggregate_sequence = $8`
	}
	result, err := transaction.Exec(ctx, query,
		operation.AgentID, input.Stage, input.Code, input.Detail,
		failedEvent.AggregateSequence, input.Now, input.RequestID,
		failedEvent.AggregateSequence-1,
	)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("mark Agent rebuild failure: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, failedEvent); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = $4, source_runtime_absence_proof = $5,
    updated_at = $6
WHERE request_id = $1`, input.RequestID, input.Code, input.Detail, input.Retryable,
		nullJSON(absenceProofPayload), input.Now); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("fail Agent rebuild operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("commit Agent rebuild failure: %w", err)
	}
	repository.recordEventAppend(ctx, input.FailedEvent.EventType)
	return state, nil
}

func advanceLifecycleOperation(
	ctx context.Context,
	transaction *databaseTransaction,
	operation ports.LifecycleOperationRecord,
	expected domain.OperationPhase,
	next domain.OperationPhase,
	nextChildRequestID string,
	attachment *ports.NetworkAttachment,
	runtime *ports.RuntimeOperation,
	now time.Time,
) error {
	var networkPayload, runtimePayload []byte
	var err error
	if attachment != nil {
		networkPayload, err = json.Marshal(attachment)
		if err != nil {
			return fmt.Errorf("encode rebuild network attachment: %w", err)
		}
	}
	if runtime != nil {
		runtimePayload, err = json.Marshal(runtime)
		if err != nil {
			return fmt.Errorf("encode rebuild Runtime result: %w", err)
		}
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations AS operation
SET phase = $2, child_request_id = $3,
    network_attachment = COALESCE($4, network_attachment),
    runtime_result = COALESCE($5, runtime_result), updated_at = $6
WHERE request_id = $1 AND state = 'running' AND phase = $7
  AND EXISTS (
      SELECT 1 FROM agent_controller.agents AS agent
      WHERE agent.id = operation.agent_id
        AND agent.active_operation_request_id = operation.request_id
  )`,
		operation.RequestID, next, nextChildRequestID,
		nullJSON(networkPayload), nullJSON(runtimePayload), now, expected,
	)
	if err != nil {
		return fmt.Errorf("advance Agent lifecycle phase: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func validateRebuildAdvance(input ports.AdvanceAgentRebuild) error {
	valid := false
	switch {
	case input.ExpectedPhase == domain.PhaseNetworkFence && input.NextPhase == domain.PhaseRuntimeUpdate:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil
	case input.ExpectedPhase == domain.PhaseRuntimeUpdate && input.NextPhase == domain.PhaseNetworkEnsure:
		valid = input.NetworkAttachment == nil && input.RuntimeResult != nil
	case input.ExpectedPhase == domain.PhaseNetworkEnsure && input.NextPhase == domain.PhasePublish:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil
	}
	if !valid || input.RequestID == "" || input.Fingerprint == "" ||
		input.NextChildRequestID == "" || input.Now.IsZero() {
		return fmt.Errorf("invalid Agent rebuild phase transition")
	}
	return nil
}

func nullJSON(payload []byte) any {
	if len(payload) == 0 {
		return nil
	}
	return payload
}

func matchesRebuildSource(agent ports.AgentRecord, input ports.BeginAgentRebuild) bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		agent.HasConfiguredRuntime() && agent.ActiveOperationRequestID == "" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		agent.AgentSpecRevisionID == input.ExpectedSpecRevisionID &&
		(input.ExpectedExecutionRevisionID == agent.ExecutionRevisionID ||
			(agent.ExecutionRevisionID == "" && input.ExpectedExecutionRevisionID == agent.LastSuccessfulExecutionRevisionID)) &&
		agent.RuntimeRevision == input.ExpectedRuntimeRevision
}

func loadAgentRebuildState(
	ctx context.Context, queryer catalogQueryer, operation ports.LifecycleOperationRecord,
) (ports.AgentRebuildState, error) {
	agent, err := loadAgentRecord(ctx, queryer, operation.AgentID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	sourceSpec, err := loadAgentSpec(ctx, queryer, operation.SourceSpecRevisionID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	sourceExecution, err := loadOptionalExecutionRevision(
		ctx, queryer, operation.SourceExecutionRevisionID,
	)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	targetSpec, err := loadAgentSpec(ctx, queryer, operation.TargetSpecRevisionID)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	return ports.AgentRebuildState{
		Agent: agent, SourceSpec: sourceSpec, SourceExecution: sourceExecution,
		TargetSpec: targetSpec, Operation: operation,
	}, nil
}

func loadOptionalExecutionRevision(
	ctx context.Context, queryer catalogQueryer, executionID string,
) (ports.ExecutionRecord, error) {
	if executionID == "" {
		return ports.ExecutionRecord{}, nil
	}
	return loadExecutionRevision(ctx, queryer, executionID)
}

func loadExecutionRevision(
	ctx context.Context, queryer catalogQueryer, executionID string,
) (ports.ExecutionRecord, error) {
	return scanExecutionRevision(queryer.QueryRow(ctx, `
SELECT id, agent_id, revision, agent_spec_revision_id, runtime_revision,
       runtime_execution_id, runtime_mcp_endpoint, runtime_mcp_source_digest,
       change_summary, published_at
FROM agent_controller.execution_revisions WHERE id = $1`, executionID))
}

func scanExecutionRevision(scanner lifecycleRowScanner) (ports.ExecutionRecord, error) {
	var record ports.ExecutionRecord
	var changeSummary []byte
	err := scanner.Scan(
		&record.ID, &record.AgentID, &record.Revision, &record.AgentSpecRevisionID,
		&record.RuntimeRevision, &record.RuntimeExecutionID, &record.RuntimeMCPEndpoint,
		&record.RuntimeMCPSourceDigest, &changeSummary, &record.PublishedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ExecutionRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.ExecutionRecord{}, fmt.Errorf("load execution revision: %w", err)
	}
	if err := json.Unmarshal(changeSummary, &record.ChangeSummary); err != nil {
		return ports.ExecutionRecord{}, fmt.Errorf("decode execution change summary: %w", err)
	}
	return record, nil
}

func loadNextLifecycleRevisions(
	ctx context.Context, queryer catalogQueryer, agentID string,
) (int64, int64, error) {
	var nextSpec, nextExecution int64
	err := queryer.QueryRow(ctx, `
SELECT
    COALESCE((SELECT MAX(revision) + 1 FROM agent_controller.agent_spec_revisions WHERE agent_id = $1), 1),
    COALESCE((SELECT MAX(revision) + 1 FROM agent_controller.execution_revisions WHERE agent_id = $1), 1)`,
		agentID,
	).Scan(&nextSpec, &nextExecution)
	if err != nil {
		return 0, 0, fmt.Errorf("load next Agent lifecycle revisions: %w", err)
	}
	return nextSpec, nextExecution, nil
}
