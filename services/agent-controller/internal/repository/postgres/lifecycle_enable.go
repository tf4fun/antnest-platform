package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetAgentEnableBase(
	ctx context.Context, agentID string,
) (ports.AgentEnableBase, error) {
	agent, err := loadAgentRecord(ctx, repository.pool, agentID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	base, err := loadAgentEnableBase(ctx, repository.pool, agent)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentEnableBase{Agent: agent}, nil
	}
	return base, err
}

func (repository *Repository) ReplayAgentEnable(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentEnableState, bool, error) {
	transaction, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("begin Agent enable replay: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentEnableState{}, false, nil
	}
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if operation.Kind != domain.OperationEnable || operation.RequestFingerprint != fingerprint {
		return ports.AgentEnableState{}, false, ports.ErrRequestConflict
	}
	state, err := loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("commit Agent enable replay: %w", err)
	}
	return state, true, nil
}

func (repository *Repository) BeginAgentEnable(
	ctx context.Context, input ports.BeginAgentEnable,
) (ports.AgentEnableState, bool, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("begin Agent enable transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "")
	switch {
	case err == nil:
		if existing.Kind != domain.OperationEnable ||
			existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentEnableState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentEnableState(ctx, transaction, existing)
		return state, true, loadErr
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentEnableState{}, false, err
	}

	if err := lockIdentityAdmission(ctx, transaction); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if !matchesEnableSource(agent, input) {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if input.OwnerAuthorizationSequence < agent.OwnerAuthorizationSequence {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if err := validateOwnerWatermark(ctx, transaction, agent.OwnerUserID, agent.OrganizationID, input.OwnerAuthorizationSequence); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	base, err := loadAgentEnableBase(ctx, transaction, agent)
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if !validEnableBegin(input, base) {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if err := requireEnabledModel(ctx, transaction, agent.OrganizationID, base.Spec.Snapshot.ModelProfileID); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'enabled', active_operation_request_id = $2,
    aggregate_sequence = $3, updated_at = $4, owner_authorization_sequence = $9
WHERE id = $1 AND desired_state = 'disabled' AND lifecycle_state = 'created' AND activation_state = 'disabled'
  AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND executable_spec_revision_id = $6 AND executable_execution_revision_id = ''
  AND last_successful_execution_revision_id = $7 AND runtime_revision = $8
  AND runtime_execution_id = '' AND runtime_mcp_endpoint = ''`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, input.ExpectedSpecRevisionID,
		input.ExpectedExecutionRevisionID, input.ExpectedRuntimeRevision,
		input.OwnerAuthorizationSequence,
	)
	if err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("attach Agent enable operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	agent.DesiredState = domain.DesiredEnabled
	agent.OwnerAuthorizationSequence = input.OwnerAuthorizationSequence
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	state := ports.AgentEnableState{
		Agent: agent, Spec: base.Spec,
		LastSuccessfulExecution: base.LastSuccessfulExecution,
		Operation:               input.Operation,
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, agent.OrganizationID); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("commit Agent enable transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) AdvanceAgentEnable(
	ctx context.Context, input ports.AdvanceAgentEnable,
) (ports.AgentEnableState, error) {
	if err := validateEnableAdvance(input); err != nil {
		return ports.AgentEnableState{}, err
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("begin Agent enable phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if operation.Kind != domain.OperationEnable || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentEnableState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if input.ExpectedPhase != domain.PhaseNetworkEnsure && operation.NetworkAttachment == nil {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if input.ExpectedPhase == domain.PhaseNetworkRestore && operation.RuntimeResult == nil {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if err := advanceLifecycleOperation(
		ctx, transaction, operation, input.ExpectedPhase, input.NextPhase,
		input.NextChildRequestID, input.NetworkAttachment, input.RuntimeResult, input.Now,
	); err != nil {
		return ports.AgentEnableState{}, err
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	state, err := loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("commit Agent enable phase: %w", err)
	}
	return state, nil
}

func (repository *Repository) PublishAgentEnable(
	ctx context.Context, input ports.PublishAgentEnable,
) (ports.AgentEnableState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("begin Agent enable publish transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationEnable, input.Fingerprint, domain.OperationCompleted,
	)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if replayed {
		return loadAgentEnableState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		operation.RuntimeResult == nil || operation.NetworkAttachment == nil ||
		operation.NetworkAttachment.AttachmentState != ports.NetworkAttachmentOpen ||
		!provisionedRuntimeResult(*operation.RuntimeResult) {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	state, err := loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if !validEnableEvent(
		input.EnabledEvent, operation, ports.EventAgentEnabled,
		state.Agent.AggregateSequence+1,
	) {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if err := publishRuntimeTarget(ctx, transaction, operation, input.EnabledEvent, input.Now); err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.EnabledEvent); err != nil {
		return ports.AgentEnableState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    error_code = '', error_detail = '', retryable = FALSE,
    updated_at = $2
WHERE request_id = $1`, input.RequestID, input.Now); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("complete Agent enable operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	state, err = loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("commit Agent enable publish: %w", err)
	}
	repository.recordEventAppend(ctx, input.EnabledEvent.EventType)
	return state, nil
}

func (repository *Repository) FailAgentEnable(
	ctx context.Context, input ports.FailAgentEnable,
) (ports.AgentEnableState, error) {
	var inspectionPayload []byte
	var err error
	if input.SourceRuntimeInspection != nil {
		inspectionPayload, err = json.Marshal(input.SourceRuntimeInspection)
		if err != nil {
			return ports.AgentEnableState{}, fmt.Errorf("encode source Runtime inspection: %w", err)
		}
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("begin Agent enable failure transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	replayed, err := authorizeLifecycleMutationOrReplay(
		operation, domain.OperationEnable, input.Fingerprint, domain.OperationFailed,
	)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if replayed {
		return loadAgentEnableState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.Stage {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if operation.RuntimeResult != nil || !validEnableFailure(input, operation) {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if !validEnableEvent(
		input.FailedEvent, operation, ports.EventAgentEnableFailed,
		agent.AggregateSequence+1,
	) {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	query := `
UPDATE agent_controller.agents
SET desired_state = 'disabled', activation_state = 'disabled', runtime_state = 'absent',
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND desired_state = 'enabled' AND lifecycle_state = 'created' AND activation_state = 'disabled'
  AND active_operation_request_id = $7 AND aggregate_sequence = $8
  AND executable_spec_revision_id = $9 AND executable_execution_revision_id = ''
  AND last_successful_execution_revision_id = $10 AND runtime_revision = $11`
	result, err := transaction.Exec(ctx, query,
		operation.AgentID, input.Stage, input.Code, input.Detail,
		input.FailedEvent.AggregateSequence, input.Now, input.RequestID,
		input.FailedEvent.AggregateSequence-1, operation.SourceSpecRevisionID,
		operation.SourceExecutionRevisionID, operation.SourceRuntimeRevision,
	)
	if err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("project Agent enable failure: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.FailedEvent); err != nil {
		return ports.AgentEnableState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = FALSE, source_runtime_inspection = $4,
    updated_at = $5
WHERE request_id = $1`, input.RequestID, input.Code, input.Detail,
		nullJSON(inspectionPayload), input.Now); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("fail Agent enable operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	state, err := loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentEnableState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("commit Agent enable failure: %w", err)
	}
	repository.recordEventAppend(ctx, input.FailedEvent.EventType)
	return state, nil
}

func loadAgentEnableBase(
	ctx context.Context, queryer catalogQueryer, agent ports.AgentRecord,
) (ports.AgentEnableBase, error) {
	if agent.AgentSpecRevisionID == "" ||
		agent.RuntimeRevision == "" {
		return ports.AgentEnableBase{Agent: agent}, nil
	}
	spec, err := loadAgentSpec(ctx, queryer, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	execution, err := loadOptionalExecutionRevision(ctx, queryer, agent.LastSuccessfulExecutionRevisionID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	_, nextExecution, err := loadNextLifecycleRevisions(ctx, queryer, agent.AgentID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	return ports.AgentEnableBase{
		Agent: agent, Spec: spec, LastSuccessfulExecution: execution,
		NextExecutionRevision: nextExecution,
	}, nil
}

func loadAgentEnableState(
	ctx context.Context, queryer catalogQueryer, operation ports.LifecycleOperationRecord,
) (ports.AgentEnableState, error) {
	agent, err := loadAgentRecord(ctx, queryer, operation.AgentID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	spec, err := loadAgentSpec(ctx, queryer, operation.SourceSpecRevisionID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	execution, err := loadOptionalExecutionRevision(ctx, queryer, operation.SourceExecutionRevisionID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	return ports.AgentEnableState{
		Agent: agent, Spec: spec, LastSuccessfulExecution: execution, Operation: operation,
	}, nil
}

func matchesEnableSource(agent ports.AgentRecord, input ports.BeginAgentEnable) bool {
	return agent.DesiredState == domain.DesiredDisabled &&
		agent.LifecycleState == domain.AgentCreated && agent.ActivationState == domain.ActivationDisabled && agent.ActiveOperationRequestID == "" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		agent.AgentSpecRevisionID == input.ExpectedSpecRevisionID &&
		agent.ExecutionRevisionID == "" &&
		agent.LastSuccessfulExecutionRevisionID == input.ExpectedExecutionRevisionID &&
		agent.RuntimeRevision == input.ExpectedRuntimeRevision &&
		agent.RuntimeExecutionID == "" && agent.RuntimeMCPEndpoint == ""
}

func validEnableBegin(input ports.BeginAgentEnable, base ports.AgentEnableBase) bool {
	return input.Operation.Kind == domain.OperationEnable &&
		input.Operation.AgentID == input.AgentID &&
		input.Operation.State == domain.OperationRunning &&
		input.Operation.Phase == domain.PhaseNetworkEnsure &&
		input.Operation.ChildRequestID == domain.ChildRequestID(
			input.Operation.RequestID, domain.PhaseNetworkEnsure,
		) &&
		input.Operation.SourceSpecRevisionID == input.ExpectedSpecRevisionID &&
		input.Operation.SourceExecutionRevisionID == input.ExpectedExecutionRevisionID &&
		input.Operation.SourceRuntimeRevision == input.ExpectedRuntimeRevision &&
		input.Operation.TargetSpecRevisionID == input.ExpectedSpecRevisionID &&
		validEnableEvent(
			input.RequestedEvent, input.Operation, ports.EventAgentEnableRequested,
			base.Agent.AggregateSequence+1,
		) &&
		base.Spec.AgentID == input.AgentID &&
		(base.LastSuccessfulExecution.ID == "" || base.LastSuccessfulExecution.AgentID == input.AgentID)
}

func validEnableEvent(
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

func validEnableFailure(
	input ports.FailAgentEnable, operation ports.LifecycleOperationRecord,
) bool {
	if input.Code == "" || input.Now.IsZero() {
		return false
	}
	inspection := input.SourceRuntimeInspection
	if (operation.Phase != domain.PhaseNetworkEnsure && operation.Phase != domain.PhaseRuntimeEnable) ||
		inspection == nil ||
		inspection.AgentID != operation.AgentID {
		return false
	}
	return inspection.RuntimeRevision == operation.SourceRuntimeRevision &&
		inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == "" &&
		inspection.LifecycleState == "disabled" && inspection.Health == "absent"
}

func validateEnableAdvance(input ports.AdvanceAgentEnable) error {
	valid := false
	switch {
	case input.ExpectedPhase == domain.PhaseNetworkEnsure &&
		input.NextPhase == domain.PhaseRuntimeEnable:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil
	case input.ExpectedPhase == domain.PhaseRuntimeEnable &&
		input.NextPhase == domain.PhaseNetworkRestore:
		valid = input.NetworkAttachment == nil && input.RuntimeResult != nil &&
			provisionedRuntimeResult(*input.RuntimeResult)
	case input.ExpectedPhase == domain.PhaseNetworkRestore &&
		input.NextPhase == domain.PhasePublish:
		valid = input.NetworkAttachment != nil && input.RuntimeResult == nil
	}
	if !valid || input.RequestID == "" || input.Fingerprint == "" ||
		input.NextChildRequestID == "" || input.Now.IsZero() {
		return fmt.Errorf("invalid Agent enable phase transition")
	}
	return nil
}

func provisionedRuntimeResult(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "provisioned" && result.Health == "unknown" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}
