package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
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
	if agent.AgentSpecRevisionID == "" || agent.ExecutionRevisionID == "" {
		return base, nil
	}
	spec, err := loadAgentSpec(ctx, repository.pool, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	execution, err := loadExecutionRevision(ctx, repository.pool, agent.ExecutionRevisionID)
	if err != nil {
		return ports.AgentLifecycleBase{}, err
	}
	base.ExecutableSpec = spec
	base.ExecutableExecution = execution
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
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("begin Agent rebuild transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "")
	switch {
	case err == nil:
		if existing.Kind != domain.OperationRebuild ||
			existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentRebuildState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentRebuildState(ctx, transaction, existing)
		return state, true, loadErr
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentRebuildState{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if !matchesRebuildSource(agent, input) {
		return ports.AgentRebuildState{}, false, ports.ErrConcurrentChange
	}
	sourceSpec, err := loadAgentSpec(ctx, transaction, input.ExpectedSpecRevisionID)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	sourceExecution, err := loadExecutionRevision(
		ctx, transaction, input.ExpectedExecutionRevisionID,
	)
	if err != nil {
		return ports.AgentRebuildState{}, false, err
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
	if err := insertAgentSpec(ctx, transaction, input.TargetSpec); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentRebuildState{}, false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET active_operation_request_id = $2, aggregate_sequence = $3, updated_at = $4
WHERE id = $1 AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND desired_state = 'enabled' AND lifecycle_state = 'available'
  AND executable_spec_revision_id = $6
  AND executable_execution_revision_id = $7 AND runtime_revision = $8`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, input.ExpectedSpecRevisionID,
		input.ExpectedExecutionRevisionID, input.ExpectedRuntimeRevision,
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
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, false, fmt.Errorf("commit Agent rebuild transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) SettleAgentRebuildDrain(
	ctx context.Context,
	requestID string,
	fingerprint string,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentRebuildState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("begin Agent rebuild drain transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if operation.Kind != domain.OperationRebuild || operation.RequestFingerprint != fingerprint {
		return ports.AgentRebuildState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhaseDrain {
		return loadAgentRebuildState(ctx, transaction, operation)
	}
	var admissionState string
	err = transaction.QueryRow(ctx, `
SELECT state FROM agent_controller.run_admissions
WHERE agent_id = $1 AND state IN ('active', 'blocked_unknown_effect')
ORDER BY admission_id LIMIT 1 FOR UPDATE`, operation.AgentID).Scan(&admissionState)
	switch {
	case err == nil && admissionState == "active":
		return loadAgentRebuildState(ctx, transaction, operation)
	case err == nil && admissionState == "blocked_unknown_effect":
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return ports.AgentRebuildState{}, fmt.Errorf("inspect Agent rebuild occupancy: %w", err)
	default:
		return ports.AgentRebuildState{}, fmt.Errorf("unsupported Run admission state %q", admissionState)
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, domain.PhaseDrain, domain.PhaseNetworkFence,
		nextChildRequestID, nil, nil, now,
	); err != nil {
		return ports.AgentRebuildState{}, err
	}
	operation, err = loadLifecycleOperation(ctx, transaction, requestID, "")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("commit Agent rebuild drain: %w", err)
	}
	return state, nil
}

func (repository *Repository) AdvanceAgentRebuild(
	ctx context.Context, input ports.AdvanceAgentRebuild,
) (ports.AgentRebuildState, error) {
	if err := validateRebuildAdvance(input); err != nil {
		return ports.AgentRebuildState{}, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("begin Agent rebuild phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := authorizeLifecycleMutation(ctx, transaction, operation); err != nil {
		return ports.AgentRebuildState{}, err
	}
	if operation.Kind != domain.OperationRebuild || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentRebuildState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, input.ExpectedPhase, input.NextPhase,
		input.NextChildRequestID, input.NetworkAttachment, input.RuntimeResult, input.Now,
	); err != nil {
		return ports.AgentRebuildState{}, err
	}
	releasedRun, retainedRun := false, false
	if input.ExpectedPhase == domain.PhaseRuntimeUpdate {
		releasedRun, retainedRun, err = repository.releaseBlockedRunAdmission(
			ctx, transaction, operation,
			runReleaseBarrier{runtimeResult: input.RuntimeResult},
			input.RunReleaseEvent, input.Now,
		)
		if err != nil {
			return ports.AgentRebuildState{}, err
		}
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("commit Agent rebuild phase: %w", err)
	}
	state.RunReleaseOutcome = runReleaseOutcome(
		input.ExpectedPhase == domain.PhaseRuntimeUpdate, releasedRun, retainedRun,
	)
	if releasedRun {
		repository.recordEventAppend(ctx, ports.EventRunAdmissionReleased)
	}
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
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		ctx, transaction, operation, domain.OperationRebuild, input.Fingerprint, domain.OperationCompleted,
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
		input.AccessRevision == "" ||
		input.Execution.AgentID != operation.AgentID ||
		input.Execution.AgentSpecRevisionID != operation.TargetSpecRevisionID ||
		input.Execution.RuntimeRevision != operation.RuntimeResult.RuntimeRevision ||
		input.Execution.RuntimeExecutionID != operation.RuntimeResult.RuntimeExecutionID ||
		input.Execution.RuntimeMCPEndpoint != operation.RuntimeResult.MCPEndpoint {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	state, err := loadAgentRebuildState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	if input.Execution.Revision != state.SourceExecution.Revision+1 ||
		input.RebuiltEvent.AggregateSequence != state.Agent.AggregateSequence+1 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	if err := insertExecutionRevision(ctx, transaction, input.Execution); err != nil {
		return ports.AgentRebuildState{}, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET lifecycle_state = 'available', executable_spec_revision_id = $2,
    executable_execution_revision_id = $3,
    last_successful_execution_revision_id = $3,
    runtime_revision = $4, runtime_execution_id = $5, runtime_mcp_endpoint = $6,
    access_revision = $7,
    active_operation_request_id = '', failure_stage = '', failure_code = '', failure_detail = '',
    aggregate_sequence = $8, updated_at = $9
WHERE id = $1 AND active_operation_request_id = $10 AND aggregate_sequence = $11`,
		operation.AgentID, input.Execution.AgentSpecRevisionID, input.Execution.ID,
		input.Execution.RuntimeRevision, input.Execution.RuntimeExecutionID,
		input.Execution.RuntimeMCPEndpoint, input.AccessRevision,
		input.RebuiltEvent.AggregateSequence, input.Now, input.RequestID,
		input.RebuiltEvent.AggregateSequence-1,
	)
	if err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("publish rebuilt Agent projection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentRebuildState{}, ports.ErrConcurrentChange
	}
	result, err = transaction.Exec(ctx, `
UPDATE agent_controller.agent_access_bindings
SET access_revision = $2, prompt_image = $3, prompt_embedded_context = $4,
    updated_at = $5
WHERE agent_id = $1 AND active = TRUE`, operation.AgentID, input.AccessRevision,
		input.PromptCapabilities.Image, input.PromptCapabilities.EmbeddedContext, input.Now,
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
    recovery_owner = '', recovery_lease_until = NULL, updated_at = $2
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
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentRebuildState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		ctx, transaction, operation, domain.OperationRebuild, input.Fingerprint, domain.OperationFailed,
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
	releasedRun, retainedRun := false, false
	switch {
	case input.RuntimeAbsenceProof == nil && !emptyRunAdmissionEvent(input.RunReleaseEvent):
		return ports.AgentRebuildState{}, fmt.Errorf("run release event requires Runtime absence proof")
	case input.RuntimeAbsenceProof != nil:
		if input.PreserveExecutable {
			return ports.AgentRebuildState{}, fmt.Errorf("invalid rebuild Runtime absence failure")
		}
		releasedRun, retainedRun, err = repository.releaseBlockedRunAdmission(
			ctx, transaction, operation,
			runReleaseBarrier{absenceProof: input.RuntimeAbsenceProof},
			input.RunReleaseEvent, input.Now,
		)
		if err != nil {
			return ports.AgentRebuildState{}, err
		}
		if releasedRun {
			agent.AggregateSequence++
		}
	}
	failedEvent := input.FailedEvent
	failedEvent.AggregateSequence = agent.AggregateSequence + 1
	query := `
UPDATE agent_controller.agents
SET lifecycle_state = 'unavailable', executable_spec_revision_id = '',
    executable_execution_revision_id = '', runtime_revision = '',
    runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND active_operation_request_id = $7 AND aggregate_sequence = $8`
	if input.PreserveExecutable {
		query = `
UPDATE agent_controller.agents
SET active_operation_request_id = '', failure_stage = $2, failure_code = $3,
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
    recovery_owner = '', recovery_lease_until = NULL, updated_at = $6
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
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRebuildState{}, fmt.Errorf("commit Agent rebuild failure: %w", err)
	}
	state.RunReleaseOutcome = runReleaseOutcome(
		input.RuntimeAbsenceProof != nil, releasedRun, retainedRun,
	)
	if releasedRun {
		repository.recordEventAppend(ctx, ports.EventRunAdmissionReleased)
	}
	repository.recordEventAppend(ctx, input.FailedEvent.EventType)
	return state, nil
}

func advanceLifecycleOperation(
	ctx context.Context,
	transaction pgx.Tx,
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
UPDATE agent_controller.agent_lifecycle_operations
SET phase = $2, child_request_id = $3,
    network_attachment = COALESCE($4, network_attachment),
    runtime_result = COALESCE($5, runtime_result), updated_at = $6
WHERE request_id = $1 AND state = 'running' AND phase = $7`,
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
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil &&
			emptyRunAdmissionEvent(input.RunReleaseEvent)
	case input.ExpectedPhase == domain.PhaseRuntimeUpdate && input.NextPhase == domain.PhaseNetworkEnsure:
		valid = input.NetworkAttachment == nil && input.RuntimeResult != nil &&
			validRunEvent(input.RunReleaseEvent, domain.AdmissionReleased)
	case input.ExpectedPhase == domain.PhaseNetworkEnsure && input.NextPhase == domain.PhasePublish:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil &&
			emptyRunAdmissionEvent(input.RunReleaseEvent)
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
	return agent.DesiredState == domain.DesiredEnabled &&
		agent.LifecycleState == domain.AgentAvailable && agent.ActiveOperationRequestID == "" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		agent.AgentSpecRevisionID == input.ExpectedSpecRevisionID &&
		agent.ExecutionRevisionID == input.ExpectedExecutionRevisionID &&
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
	sourceExecution, err := loadExecutionRevision(
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
