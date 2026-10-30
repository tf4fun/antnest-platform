package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var lifecycleTerminationCodes = map[string]bool{
	"phase_deadline_exceeded": true,
	"lifecycle_cancelled":     true,
}

func lifecycleTerminationEventType(kind domain.OperationKind, code string) string {
	if code == "lifecycle_cancelled" {
		return ports.EventAgentLifecycleCancelled
	}
	switch kind {
	case domain.OperationCreate, domain.OperationRebuild:
		return ports.EventAgentBuildFailed
	case domain.OperationDisable:
		return ports.EventAgentDisableFailed
	case domain.OperationEnable:
		return ports.EventAgentEnableFailed
	default:
		return ports.EventAgentLifecycleQuarantined
	}
}

func (repository *Repository) TerminateLifecycleOperation(
	ctx context.Context, input ports.TerminateLifecycleOperation,
) (ports.LifecycleOperationRecord, error) {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.Fingerprint) == "" ||
		input.ExpectedPhase == "" || !lifecycleTerminationCodes[input.ErrorCode] ||
		strings.TrimSpace(input.EventID) == "" {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("invalid lifecycle termination")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("begin lifecycle termination: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if operation.RequestFingerprint != input.Fingerprint {
		return ports.LifecycleOperationRecord{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning {
		if err := transaction.Commit(ctx); err != nil {
			return ports.LifecycleOperationRecord{}, err
		}
		return operation, nil
	}
	if operation.Phase != input.ExpectedPhase {
		return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
	}

	var aggregateSequence int64
	var activeOperationRequestID, specRevisionID string
	var now time.Time
	if err := transaction.QueryRow(ctx, `
SELECT aggregate_sequence, active_operation_request_id, executable_spec_revision_id, clock_timestamp()
FROM agent_controller.agents
WHERE id = $1
FOR UPDATE`, operation.AgentID).Scan(
		&aggregateSequence, &activeOperationRequestID, &specRevisionID, &now); err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("lock terminated Agent: %w", err)
	}
	if activeOperationRequestID != input.RequestID {
		return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
	}
	nextSequence := aggregateSequence + 1
	targetSpec := specRevisionID
	if operation.Kind == domain.OperationCreate && targetSpec == "" {
		targetSpec = operation.TargetSpecRevisionID
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET active_operation_request_id = '', executable_execution_revision_id = '',
    runtime_execution_id = '', runtime_mcp_endpoint = '',
    executable_spec_revision_id = $2,
    runtime_state = 'unknown', runtime_reason = $3,
    failure_stage = $4, failure_code = $5, failure_detail = $6,
    aggregate_sequence = $7, updated_at = $8
WHERE id = $1 AND active_operation_request_id = $9 AND aggregate_sequence = $10`,
		operation.AgentID, targetSpec, input.ErrorCode, operation.Phase,
		input.ErrorCode, input.ErrorDetail, nextSequence, now,
		input.RequestID, aggregateSequence,
	)
	if err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("terminate Agent lifecycle: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LifecycleOperationRecord{}, ports.ErrConcurrentChange
	}
	eventType := lifecycleTerminationEventType(operation.Kind, input.ErrorCode)
	if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
		EventID: input.EventID, AgentID: operation.AgentID,
		AggregateSequence: nextSequence, SchemaVersion: 1,
		EventType:          eventType,
		OperationRequestID: input.RequestID, TraceID: input.TraceID,
		Data: map[string]any{
			"failure_stage": string(operation.Phase),
			"failure_code":  input.ErrorCode,
		},
		OccurredAt: now,
	}); err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = FALSE,
    updated_at = $4
WHERE request_id = $1`, input.RequestID, input.ErrorCode, input.ErrorDetail, now); err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("terminate lifecycle operation: %w", err)
	}
	if err := repository.advanceAgentExecutionRevision(ctx, transaction, operation.AgentID); err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("commit lifecycle termination: %w", err)
	}
	repository.recordEventAppend(ctx, eventType)
	operation.State = domain.OperationFailed
	operation.ErrorCode = input.ErrorCode
	operation.ErrorDetail = input.ErrorDetail
	operation.ChildRequestID = ""
	operation.Retryable = false
	operation.UpdatedAt = now
	return operation, nil
}

func (repository *Repository) ClearLifecycleQuarantine(
	ctx context.Context, input ports.ClearLifecycleQuarantine,
) (ports.AgentRecord, error) {
	if strings.TrimSpace(input.OrganizationID) == "" || strings.TrimSpace(input.ActorPrincipalID) == "" ||
		strings.TrimSpace(input.AgentID) == "" || input.ExpectedAggregateSequence < 1 ||
		strings.TrimSpace(input.EventID) == "" {
		return ports.AgentRecord{}, fmt.Errorf("invalid quarantine clear")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentRecord{}, fmt.Errorf("begin quarantine clear: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()

	if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
		return ports.AgentRecord{}, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.AgentRecord{}, err
	}
	if agent.OrganizationID != input.OrganizationID ||
		agent.AggregateSequence != input.ExpectedAggregateSequence {
		return ports.AgentRecord{}, ports.ErrConcurrentChange
	}
	base := ports.AgentLifecycleBase{Agent: agent}
	if agent.AgentSpecRevisionID != "" {
		base.ConfiguredSpec, err = loadAgentSpec(ctx, transaction, agent.AgentSpecRevisionID)
		if err != nil {
			return ports.AgentRecord{}, err
		}
	}
	if agent.LastSuccessfulExecutionRevisionID != "" {
		base.SourceExecution, err = loadOptionalExecutionRevision(ctx, transaction, agent.LastSuccessfulExecutionRevisionID)
		if err != nil {
			return ports.AgentRecord{}, err
		}
	}
	if !ports.CanClearLifecycleQuarantine(base) {
		return ports.AgentRecord{}, ports.ErrConcurrentChange
	}
	if base.ConfiguredSpec.ID != input.ExpectedSpecRevisionID ||
		agent.RuntimeRevision != input.ExpectedRuntimeRevision ||
		agent.LastSuccessfulExecutionRevisionID != input.ExpectedLastSuccessfulExecutionRevisionID {
		return ports.AgentRecord{}, ports.ErrConcurrentChange
	}
	if !ports.ValidQuarantineRuntimeInspection(agent, input.Inspection) {
		return ports.AgentRecord{}, ports.ErrConcurrentChange
	}
	nextSequence := agent.AggregateSequence + 1
	var now time.Time
	if err := transaction.QueryRow(ctx, `
UPDATE agent_controller.agents
SET failure_stage = '', failure_code = '', failure_detail = '',
    runtime_state = 'unknown', runtime_reason = '',
    aggregate_sequence = $2, updated_at = clock_timestamp()
WHERE id = $1 AND organization_id = $3 AND aggregate_sequence = $4 AND active_operation_request_id = ''
RETURNING updated_at`,
		agent.AgentID, nextSequence, input.OrganizationID, input.ExpectedAggregateSequence,
	).Scan(&now); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.AgentRecord{}, ports.ErrConcurrentChange
		}
		return ports.AgentRecord{}, fmt.Errorf("clear Agent quarantine: %w", err)
	}
	if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
		EventID: input.EventID, AgentID: agent.AgentID,
		AggregateSequence: nextSequence, SchemaVersion: 1,
		EventType: ports.EventAgentLifecycleQuarantineCleared,
		TraceID:   input.TraceID,
		Data: map[string]any{
			"actor_principal_id": input.ActorPrincipalID,
		},
		OccurredAt: now,
	}); err != nil {
		return ports.AgentRecord{}, err
	}
	if err := repository.advanceAgentExecutionRevision(ctx, transaction, agent.AgentID); err != nil {
		return ports.AgentRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentRecord{}, fmt.Errorf("commit quarantine clear: %w", err)
	}
	repository.recordEventAppend(ctx, ports.EventAgentLifecycleQuarantineCleared)
	agent.FailureStage = ""
	agent.FailureCode = ""
	agent.FailureDetail = ""
	agent.RuntimeReason = ""
	agent.RuntimeState = domain.RuntimeUnknown
	agent.AggregateSequence = nextSequence
	agent.UpdatedAt = now
	return agent, nil
}
