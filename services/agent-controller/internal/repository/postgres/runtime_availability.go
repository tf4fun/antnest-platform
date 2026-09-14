package postgres

import (
	"context"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) ListPendingRuntimeBindings(ctx context.Context, after string, limit int) ([]ports.PendingRuntimeBinding, error) {
	if limit < 1 || limit > 500 {
		return nil, fmt.Errorf("pending Runtime page limit must be between 1 and 500")
	}
	rows, err := repository.pool.Query(ctx, `
SELECT a.id, op.request_id
FROM agent_controller.agents a
JOIN LATERAL (
    SELECT request_id FROM agent_controller.agent_lifecycle_operations
    WHERE agent_id = a.id AND state = 'completed' AND kind IN ('create', 'rebuild', 'enable')
      AND target_spec_revision_id = a.executable_spec_revision_id
      AND runtime_result->>'runtime_revision' = a.runtime_revision
    ORDER BY updated_at DESC, request_id DESC LIMIT 1
) op ON TRUE
WHERE a.id > $1 AND a.lifecycle_state = 'created' AND a.activation_state = 'enabled'
  AND (a.runtime_state <> 'available' OR (a.executable_execution_revision_id = '' AND a.failure_stage <> 'runtime_observation'))
  AND a.desired_state = 'enabled' AND a.active_operation_request_id = ''
  AND a.identity_revocation_sequence <= a.owner_authorization_sequence
ORDER BY a.id LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending Runtime bindings: %w", err)
	}
	type candidate struct{ agentID, requestID string }
	var candidates []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.agentID, &item.requestID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan pending Runtime binding: %w", err)
		}
		candidates = append(candidates, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]ports.PendingRuntimeBinding, 0, len(candidates))
	for _, item := range candidates {
		pending, err := repository.loadPendingRuntimeBinding(ctx, item.agentID, item.requestID)
		if err != nil {
			return nil, err
		}
		result = append(result, pending)
	}
	return result, nil
}

func (repository *Repository) loadPendingRuntimeBinding(ctx context.Context, agentID, requestID string) (ports.PendingRuntimeBinding, error) {
	var result ports.PendingRuntimeBinding
	var err error
	result.Agent, err = loadAgentRecord(ctx, repository.pool, agentID)
	if err != nil {
		return result, err
	}
	result.Operation, err = loadLifecycleOperation(ctx, repository.pool, requestID, "")
	if err != nil {
		return result, err
	}
	result.Spec, err = loadAgentSpec(ctx, repository.pool, result.Operation.TargetSpecRevisionID)
	if err != nil {
		return result, err
	}
	_, result.NextExecutionRevision, err = loadNextLifecycleRevisions(ctx, repository.pool, agentID)
	return result, err
}

func (repository *Repository) PublishRuntimeBinding(ctx context.Context, input ports.PublishRuntimeBinding) (bool, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin Runtime binding publication: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockIdentityAdmission(ctx, tx); err != nil {
		return false, err
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, input.Execution.AgentID); err != nil {
		return false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, input.Execution.AgentID)
	if err != nil {
		return false, err
	}
	if !agent.AwaitingRuntimeBinding() || agent.AggregateSequence != input.ExpectedAggregateSequence {
		return false, nil
	}
	previous, err := loadOptionalExecutionRevision(ctx, tx, agent.LastSuccessfulExecutionRevisionID)
	if err != nil {
		return false, err
	}
	// A target receives its execution binding once. Losing that binding requires
	// a new lifecycle target, not a health observation that revives the old one.
	if previous.ID != "" && previous.RuntimeRevision == agent.RuntimeRevision {
		return false, nil
	}
	if err := validateOwnerWatermark(ctx, tx, agent.OwnerUserID, agent.OrganizationID, agent.OwnerAuthorizationSequence); err != nil {
		return false, err
	}
	operation, err := loadLifecycleOperation(ctx, tx, input.OperationRequestID, "")
	if err != nil {
		return false, err
	}
	_, nextExecution, err := loadNextLifecycleRevisions(ctx, tx, agent.AgentID)
	if err != nil {
		return false, err
	}
	if !validObservedPublication(agent, operation, nextExecution, input) {
		return false, ports.ErrConcurrentChange
	}
	spec, err := loadAgentSpec(ctx, tx, agent.AgentSpecRevisionID)
	if err != nil {
		return false, err
	}
	if err := requireEnabledModel(ctx, tx, agent.OrganizationID, spec.Snapshot.ModelProfileID); err != nil {
		return false, err
	}
	if err := insertExecutionRevision(ctx, tx, input.Execution); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE agent_controller.agents
SET runtime_state = 'available', runtime_reason = '', runtime_detail = '', runtime_observed_at = $6,
    executable_execution_revision_id = $2,
    last_successful_execution_revision_id = $2, runtime_execution_id = $3,
    runtime_mcp_endpoint = $4, aggregate_sequence = $5, updated_at = $6,
    failure_stage = '', failure_code = '', failure_detail = ''
WHERE id = $1`, agent.AgentID, input.Execution.ID, input.Execution.RuntimeExecutionID,
		input.Execution.RuntimeMCPEndpoint, input.ReadyEvent.AggregateSequence, input.Execution.PublishedAt); err != nil {
		return false, fmt.Errorf("publish observed Runtime binding: %w", err)
	}
	if err := repository.insertAgentEvent(ctx, tx, input.ReadyEvent); err != nil {
		return false, err
	}
	if err := repository.advanceExecutionRevision(ctx, tx, agent.OrganizationID); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit Runtime binding: %w", err)
	}
	repository.recordEventAppend(ctx, input.ReadyEvent.EventType)
	return true, nil
}

func validObservedPublication(agent ports.AgentRecord, operation ports.LifecycleOperationRecord, next int64, input ports.PublishRuntimeBinding) bool {
	execution := input.Execution
	if operation.State != domain.OperationCompleted || operation.AgentID != agent.AgentID ||
		operation.TargetSpecRevisionID != agent.AgentSpecRevisionID || operation.RuntimeResult == nil ||
		!provisionedRuntimeResult(*operation.RuntimeResult) || operation.RuntimeResult.RuntimeRevision != agent.RuntimeRevision {
		return false
	}
	return execution.ID != "" && execution.Revision == next &&
		execution.AgentSpecRevisionID == agent.AgentSpecRevisionID && execution.RuntimeRevision == agent.RuntimeRevision &&
		execution.RuntimeExecutionID != "" && execution.RuntimeMCPEndpoint != "" && !execution.PublishedAt.IsZero() &&
		validEnableEvent(input.ReadyEvent, operation, ports.EventAgentReady, agent.AggregateSequence+1)
}
