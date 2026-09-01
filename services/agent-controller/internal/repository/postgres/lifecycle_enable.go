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

	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if !matchesEnableSource(agent, input) {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	base, err := loadAgentEnableBase(ctx, transaction, agent)
	if err != nil {
		return ports.AgentEnableState{}, false, err
	}
	if !validEnableBegin(input, base) {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'enabled', active_operation_request_id = $2,
    aggregate_sequence = $3, updated_at = $4
WHERE id = $1 AND desired_state = 'disabled' AND lifecycle_state = 'disabled'
  AND active_operation_request_id = '' AND aggregate_sequence = $5
  AND executable_spec_revision_id = $6 AND executable_execution_revision_id = ''
  AND last_successful_execution_revision_id = $7 AND runtime_revision = $8
  AND runtime_execution_id = '' AND runtime_mcp_endpoint = ''`,
		input.AgentID, input.Operation.RequestID, input.RequestedEvent.AggregateSequence,
		input.Now, input.ExpectedAggregateSequence, input.ExpectedSpecRevisionID,
		input.ExpectedExecutionRevisionID, input.ExpectedRuntimeRevision,
	)
	if err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("attach Agent enable operation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentEnableState{}, false, ports.ErrConcurrentChange
	}
	if err := insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentEnableState{}, false, err
	}
	agent.DesiredState = domain.DesiredEnabled
	agent.ActiveOperationRequestID = input.Operation.RequestID
	agent.AggregateSequence = input.RequestedEvent.AggregateSequence
	agent.UpdatedAt = input.Now
	state := ports.AgentEnableState{
		Agent: agent, Spec: base.Spec,
		LastSuccessfulExecution: base.LastSuccessfulExecution,
		Operation:               input.Operation,
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, false, fmt.Errorf("commit Agent enable transaction: %w", err)
	}
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
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if operation.Kind != domain.OperationEnable || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentEnableState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.ExpectedPhase ||
		operation.NetworkPolicyAssignment == nil {
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
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if operation.Kind != domain.OperationEnable || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentEnableState{}, ports.ErrRequestConflict
	}
	if operation.State == domain.OperationCompleted {
		return loadAgentEnableState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		operation.RuntimeResult == nil || operation.NetworkAttachment == nil ||
		operation.NetworkPolicyAssignment == nil || !readyRuntimeResult(*operation.RuntimeResult) ||
		input.Execution.AgentID != operation.AgentID ||
		input.Execution.AgentSpecRevisionID != operation.TargetSpecRevisionID ||
		input.Execution.RuntimeRevision != operation.RuntimeResult.RuntimeRevision ||
		input.Execution.RuntimeExecutionID != operation.RuntimeResult.RuntimeExecutionID ||
		input.Execution.RuntimeMCPEndpoint != operation.RuntimeResult.MCPEndpoint {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	state, err := loadAgentEnableState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if input.Execution.Revision != state.LastSuccessfulExecution.Revision+1 ||
		!validEnableEvent(
			input.EnabledEvent, operation, ports.EventAgentEnabled,
			state.Agent.AggregateSequence+1,
		) {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if err := insertExecutionRevision(ctx, transaction, input.Execution); err != nil {
		return ports.AgentEnableState{}, err
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET desired_state = 'enabled', lifecycle_state = 'available',
    executable_spec_revision_id = $2, executable_execution_revision_id = $3,
    last_successful_execution_revision_id = $3,
    runtime_revision = $4, runtime_execution_id = $5, runtime_mcp_endpoint = $6,
    active_operation_request_id = '', failure_stage = '', failure_code = '', failure_detail = '',
    aggregate_sequence = $7, updated_at = $8
WHERE id = $1 AND desired_state = 'enabled' AND lifecycle_state = 'disabled'
  AND active_operation_request_id = $9 AND aggregate_sequence = $10
  AND executable_spec_revision_id = $2 AND executable_execution_revision_id = ''
  AND last_successful_execution_revision_id = $11 AND runtime_revision = $12
  AND runtime_execution_id = '' AND runtime_mcp_endpoint = ''`,
		operation.AgentID, input.Execution.AgentSpecRevisionID, input.Execution.ID,
		input.Execution.RuntimeRevision, input.Execution.RuntimeExecutionID,
		input.Execution.RuntimeMCPEndpoint, input.EnabledEvent.AggregateSequence,
		input.Now, input.RequestID, input.EnabledEvent.AggregateSequence-1,
		operation.SourceExecutionRevisionID, operation.SourceRuntimeRevision,
	)
	if err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("publish enabled Agent projection: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentEnableState{}, ports.ErrConcurrentChange
	}
	if err := insertAgentEvent(ctx, transaction, input.EnabledEvent); err != nil {
		return ports.AgentEnableState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    error_code = '', error_detail = '', retryable = FALSE, updated_at = $2
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
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("commit Agent enable publish: %w", err)
	}
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
	operation, err := loadLifecycleOperation(ctx, transaction, input.RequestID, "FOR UPDATE")
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	if operation.Kind != domain.OperationEnable || operation.RequestFingerprint != input.Fingerprint {
		return ports.AgentEnableState{}, ports.ErrRequestConflict
	}
	if operation.State == domain.OperationFailed {
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
SET desired_state = 'disabled', lifecycle_state = 'disabled',
    active_operation_request_id = '', failure_stage = $2, failure_code = $3,
    failure_detail = $4, aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND desired_state = 'enabled' AND lifecycle_state = 'disabled'
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
	if err := insertAgentEvent(ctx, transaction, input.FailedEvent); err != nil {
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
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentEnableState{}, fmt.Errorf("commit Agent enable failure: %w", err)
	}
	return state, nil
}

func loadAgentEnableBase(
	ctx context.Context, queryer catalogQueryer, agent ports.AgentRecord,
) (ports.AgentEnableBase, error) {
	if agent.AgentSpecRevisionID == "" || agent.LastSuccessfulExecutionRevisionID == "" ||
		agent.RuntimeRevision == "" {
		return ports.AgentEnableBase{Agent: agent}, nil
	}
	spec, err := loadAgentSpec(ctx, queryer, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	execution, err := loadExecutionRevision(ctx, queryer, agent.LastSuccessfulExecutionRevisionID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	_, nextExecution, err := loadNextLifecycleRevisions(ctx, queryer, agent.AgentID)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	policy, err := loadCompletedDisablePolicy(ctx, queryer, agent)
	if err != nil {
		return ports.AgentEnableBase{}, err
	}
	return ports.AgentEnableBase{
		Agent: agent, Spec: spec, LastSuccessfulExecution: execution,
		NetworkPolicyAssignment: policy, NextExecutionRevision: nextExecution,
	}, nil
}

func loadCompletedDisablePolicy(
	ctx context.Context, queryer catalogQueryer, agent ports.AgentRecord,
) (ports.NetworkPolicyAssignment, error) {
	var payload []byte
	err := queryer.QueryRow(ctx, `
SELECT network_policy_assignment
FROM agent_controller.agent_lifecycle_operations
WHERE agent_id = $1 AND kind = 'disable' AND state = 'completed'
  AND source_spec_revision_id = $2 AND source_execution_revision_id = $3
  AND runtime_result->>'runtime_revision' = $4
  AND network_policy_assignment IS NOT NULL
ORDER BY updated_at DESC, request_id DESC LIMIT 1`,
		agent.AgentID, agent.AgentSpecRevisionID,
		agent.LastSuccessfulExecutionRevisionID, agent.RuntimeRevision,
	).Scan(&payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.NetworkPolicyAssignment{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.NetworkPolicyAssignment{}, fmt.Errorf("load disabled Agent policy: %w", err)
	}
	var assignment ports.NetworkPolicyAssignment
	if err := json.Unmarshal(payload, &assignment); err != nil {
		return ports.NetworkPolicyAssignment{}, fmt.Errorf("decode disabled Agent policy: %w", err)
	}
	return assignment, nil
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
	execution, err := loadExecutionRevision(ctx, queryer, operation.SourceExecutionRevisionID)
	if err != nil {
		return ports.AgentEnableState{}, err
	}
	return ports.AgentEnableState{
		Agent: agent, Spec: spec, LastSuccessfulExecution: execution, Operation: operation,
	}, nil
}

func matchesEnableSource(agent ports.AgentRecord, input ports.BeginAgentEnable) bool {
	return agent.DesiredState == domain.DesiredDisabled &&
		agent.LifecycleState == domain.AgentDisabled && agent.ActiveOperationRequestID == "" &&
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
		input.Operation.NetworkPolicyAssignment != nil &&
		*input.Operation.NetworkPolicyAssignment == base.NetworkPolicyAssignment &&
		validEnableEvent(
			input.RequestedEvent, input.Operation, ports.EventAgentEnableRequested,
			base.Agent.AggregateSequence+1,
		) &&
		base.Spec.AgentID == input.AgentID &&
		base.LastSuccessfulExecution.AgentID == input.AgentID &&
		base.LastSuccessfulExecution.AgentSpecRevisionID == base.Spec.ID &&
		base.NextExecutionRevision == base.LastSuccessfulExecution.Revision+1
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
	if operation.Phase == domain.PhaseNetworkEnsure {
		return inspection == nil
	}
	if operation.Phase != domain.PhaseRuntimeEnable || inspection == nil ||
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
			readyRuntimeResult(*input.RuntimeResult)
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

func readyRuntimeResult(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "ready" && result.Health == "healthy" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID != "" && result.MCPEndpoint != ""
}
