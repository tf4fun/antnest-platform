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

const lifecycleRequestLockNamespace int32 = 0x41474e54

type lifecycleRowScanner interface {
	Scan(...any) error
}

func (repository *Repository) GetLifecycleOperation(
	ctx context.Context, requestID string,
) (ports.LifecycleOperationRecord, error) {
	return loadLifecycleOperation(ctx, repository.pool, requestID, "")
}

func (repository *Repository) ReplayAgentCreate(
	ctx context.Context, requestID string, fingerprint string,
) (ports.AgentCreateState, bool, error) {
	transaction, err := repository.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ports.AgentCreateState{}, false, fmt.Errorf("begin Agent create replay: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleOperation(ctx, transaction, requestID, "")
	if errors.Is(err, ports.ErrNotFound) {
		return ports.AgentCreateState{}, false, nil
	}
	if err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if operation.Kind != domain.OperationCreate || operation.RequestFingerprint != fingerprint {
		return ports.AgentCreateState{}, false, ports.ErrRequestConflict
	}
	state, err := loadAgentCreateState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentCreateState{}, false, fmt.Errorf("commit Agent create replay: %w", err)
	}
	return state, true, nil
}

func (repository *Repository) BeginAgentCreate(
	ctx context.Context, input ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentCreateState{}, false, fmt.Errorf("begin Agent create transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.Operation.RequestID); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	existing, err := loadLifecycleOperation(ctx, transaction, input.Operation.RequestID, "")
	switch {
	case err == nil:
		if existing.Kind != domain.OperationCreate || existing.RequestFingerprint != input.Operation.RequestFingerprint {
			return ports.AgentCreateState{}, false, ports.ErrRequestConflict
		}
		state, loadErr := loadAgentCreateState(ctx, transaction, existing)
		return state, true, loadErr
	case !errors.Is(err, ports.ErrNotFound):
		return ports.AgentCreateState{}, false, err
	}
	if err := lockIdentityAdmission(ctx, transaction); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := lockExecutionOrganization(ctx, transaction, input.Agent.OrganizationID); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := validateOwnerWatermark(ctx, transaction, input.Agent.OwnerUserID, input.Agent.OrganizationID, input.Agent.OwnerAuthorizationSequence); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := requireEnabledTemplateSpec(ctx, transaction, input.Agent.OrganizationID, input.Spec.Snapshot); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := insertAgent(ctx, transaction, input.Agent); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := insertAgentSpec(ctx, transaction, input.Spec); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := insertAgentAccess(ctx, transaction, input.Access); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := insertLifecycleOperation(ctx, transaction, input.Operation); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.RequestedEvent); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	state := ports.AgentCreateState{
		Agent: input.Agent, Access: input.Access, Spec: input.Spec, Operation: input.Operation,
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, input.Agent.OrganizationID); err != nil {
		return ports.AgentCreateState{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentCreateState{}, false, fmt.Errorf("commit Agent create transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.RequestedEvent.EventType)
	return state, false, nil
}

func (repository *Repository) RecordCreateNetwork(
	ctx context.Context,
	requestID string,
	fingerprint string,
	attachment ports.NetworkAttachment,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	payload, err := json.Marshal(attachment)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("encode Agent network attachment: %w", err)
	}
	return repository.advanceCreatePhase(
		ctx, requestID, fingerprint, domain.PhaseNetworkEnsure, domain.PhaseRuntimeInitialize,
		nextChildRequestID, "network_attachment", payload, now,
	)
}

func (repository *Repository) RecordCreateRuntime(
	ctx context.Context,
	requestID string,
	fingerprint string,
	runtime ports.RuntimeOperation,
	nextChildRequestID string,
	now time.Time,
) (ports.AgentCreateState, error) {
	payload, err := json.Marshal(runtime)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("encode Runtime result: %w", err)
	}
	return repository.advanceCreatePhase(
		ctx, requestID, fingerprint, domain.PhaseRuntimeInitialize, domain.PhasePublish,
		nextChildRequestID, "runtime_result", payload, now,
	)
}

func (repository *Repository) advanceCreatePhase(
	ctx context.Context,
	requestID string,
	fingerprint string,
	expected domain.OperationPhase,
	next domain.OperationPhase,
	nextChildRequestID string,
	column string,
	payload []byte,
	now time.Time,
) (ports.AgentCreateState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("begin create phase transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, requestID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if operation.Kind != domain.OperationCreate || operation.RequestFingerprint != fingerprint {
		return ports.AgentCreateState{}, ports.ErrRequestConflict
	}
	if operation.State != domain.OperationRunning || operation.Phase != expected {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	if column != "network_attachment" && column != "runtime_result" {
		return ports.AgentCreateState{}, fmt.Errorf("unsupported lifecycle payload column")
	}
	query := fmt.Sprintf(`
UPDATE agent_controller.agent_lifecycle_operations
SET phase = $2, child_request_id = $3, %s = $4, updated_at = $5
WHERE request_id = $1 AND state = 'running' AND phase = $6`, column)
	result, err := transaction.Exec(ctx, query, requestID, next, nextChildRequestID, payload, now, expected)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("advance Agent create phase: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	operation, err = loadLifecycleOperation(ctx, transaction, requestID, "")
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	state, err := loadAgentCreateState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("commit Agent create phase: %w", err)
	}
	return state, nil
}

func (repository *Repository) PublishAgentCreate(
	ctx context.Context, input ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("begin Agent publish transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	replayed, err := authorizeCreateResult(operation, input.Fingerprint, domain.OperationCompleted)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if replayed {
		return loadAgentCreateState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != domain.PhasePublish ||
		operation.RuntimeResult == nil || operation.NetworkAttachment == nil ||
		input.NetworkAttachment.AgentID != operation.AgentID ||
		input.NetworkAttachment.State != ports.NetworkStateActive ||
		input.NetworkAttachment.AttachmentState != ports.NetworkAttachmentOpen ||
		input.NetworkAttachment.NetworkResourceVersion != operation.NetworkAttachment.NetworkResourceVersion {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	networkPayload, err := json.Marshal(input.NetworkAttachment)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("encode published Agent network attachment: %w", err)
	}
	if err := publishRuntimeTarget(ctx, transaction, operation, input.CreatedEvent, input.Now); err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.CreatedEvent); err != nil {
		return ports.AgentCreateState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET phase = 'completed', state = 'completed', child_request_id = '',
    network_attachment = $2,
	    error_code = '', error_detail = '', retryable = FALSE,
	    updated_at = $3
WHERE request_id = $1`, input.RequestID, networkPayload, input.Now); err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("complete Agent create operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	state, err := loadAgentCreateState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("commit Agent publish transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.CreatedEvent.EventType)
	return state, nil
}

func (repository *Repository) FailAgentCreate(
	ctx context.Context, input ports.FailAgentCreate,
) (ports.AgentCreateState, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("begin Agent failure transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	operation, err := loadLifecycleExecutionMutation(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	replayed, err := authorizeCreateResult(operation, input.Fingerprint, domain.OperationFailed)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if replayed {
		return loadAgentCreateState(ctx, transaction, operation)
	}
	if operation.State != domain.OperationRunning || operation.Phase != input.Stage {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET active_operation_request_id = '',
    failure_stage = $2, failure_code = $3, failure_detail = $4,
    aggregate_sequence = $5, updated_at = $6
WHERE id = $1 AND active_operation_request_id = $7 AND aggregate_sequence = $8`,
		operation.AgentID, input.Stage, input.Code, input.Detail,
		input.FailedEvent.AggregateSequence, input.Now, input.RequestID,
		input.FailedEvent.AggregateSequence-1,
	)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("mark Agent create failure: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, input.FailedEvent); err != nil {
		return ports.AgentCreateState{}, err
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations
SET state = 'failed', child_request_id = '', error_code = $2,
    error_detail = $3, retryable = $4,
    updated_at = $5
WHERE request_id = $1`, input.RequestID, input.Code, input.Detail, input.Retryable, input.Now); err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("fail Agent create operation: %w", err)
	}
	operation, err = loadLifecycleOperation(ctx, transaction, input.RequestID, "")
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	state, err := loadAgentCreateState(ctx, transaction, operation)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, transaction, state.Agent.OrganizationID); err != nil {
		return ports.AgentCreateState{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("commit Agent failure transaction: %w", err)
	}
	repository.recordEventAppend(ctx, input.FailedEvent.EventType)
	return state, nil
}

func lockLifecycleRequest(ctx context.Context, transaction *databaseTransaction, requestID string) error {
	if _, err := transaction.Exec(
		ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", lifecycleRequestLockNamespace, requestID,
	); err != nil {
		return fmt.Errorf("lock lifecycle request: %w", err)
	}
	return nil
}

func authorizeCreateResult(operation ports.LifecycleOperationRecord, fingerprint string, target domain.OperationState) (bool, error) {
	if operation.Kind != domain.OperationCreate || operation.RequestFingerprint != fingerprint {
		return false, ports.ErrRequestConflict
	}
	return operation.State == target, nil
}

func insertAgent(ctx context.Context, transaction *databaseTransaction, record ports.AgentRecord) error {
	_, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agents (
    id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
    access_revision, active_operation_request_id, aggregate_sequence, created_at, updated_at, owner_authorization_sequence,
    activation_state, runtime_state
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE(NULLIF($14,''),'unknown'))`,
		record.AgentID, record.OrganizationID, record.OwnerUserID, record.Name,
		record.DesiredState, record.LifecycleState, record.AccessRevision,
		record.ActiveOperationRequestID, record.AggregateSequence, record.CreatedAt, record.UpdatedAt,
		record.OwnerAuthorizationSequence,
		record.ActivationState, record.RuntimeState,
	)
	if err != nil {
		return fmt.Errorf("insert Agent: %w", err)
	}
	return nil
}

func insertAgentSpec(ctx context.Context, transaction *databaseTransaction, record ports.AgentSpecRecord) error {
	payload, err := json.Marshal(record.Snapshot)
	if err != nil {
		return fmt.Errorf("encode Agent spec: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_spec_revisions (
    id, agent_id, revision, template_id, template_revision,
    model_profile_revision_id, canonical_digest, snapshot, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		record.ID, record.AgentID, record.Revision, record.Snapshot.TemplateID,
		record.Snapshot.TemplateRevision, record.Snapshot.ModelProfileRevisionID,
		record.CanonicalDigest, payload, record.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert Agent spec revision: %w", err)
	}
	return nil
}

func insertAgentAccess(ctx context.Context, transaction *databaseTransaction, record ports.AgentAccessRecord) error {
	_, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_access_bindings (
    agent_id, principal_id, access_revision, active, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6)`,
		record.AgentID, record.PrincipalID, record.AccessRevision,
		record.Active, record.CreatedAt, record.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert Agent access binding: %w", err)
	}
	return nil
}

func insertLifecycleOperation(
	ctx context.Context, transaction *databaseTransaction, record ports.LifecycleOperationRecord,
) error {
	var inspectionPayload, absenceProofPayload []byte
	var err error
	if record.SourceRuntimeInspection != nil {
		inspectionPayload, err = json.Marshal(record.SourceRuntimeInspection)
		if err != nil {
			return fmt.Errorf("encode source Runtime inspection: %w", err)
		}
	}
	if record.SourceRuntimeAbsenceProof != nil {
		absenceProofPayload, err = json.Marshal(record.SourceRuntimeAbsenceProof)
		if err != nil {
			return fmt.Errorf("encode source Runtime absence proof: %w", err)
		}
	}
	_, err = transaction.Exec(ctx, `
	INSERT INTO agent_controller.agent_lifecycle_operations (
    request_id, request_fingerprint, agent_id, kind, phase, state,
    source_spec_revision_id, source_execution_revision_id,
    source_runtime_revision, source_runtime_absent,
    target_spec_revision_id, child_request_id,
    source_runtime_inspection, source_runtime_absence_proof, network_release_outcome,
    created_at, updated_at, owner_revocation_sequence, drain_deadline_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, clock_timestamp(), clock_timestamp(), $16, $17
)`,
		record.RequestID, record.RequestFingerprint, record.AgentID, record.Kind,
		record.Phase, record.State, record.SourceSpecRevisionID,
		record.SourceExecutionRevisionID, record.SourceRuntimeRevision,
		record.SourceRuntimeAbsent, record.TargetSpecRevisionID, record.ChildRequestID,
		nullJSON(inspectionPayload), nullJSON(absenceProofPayload),
		record.NetworkReleaseOutcome,
		record.OwnerRevocationSequence,
		record.DrainDeadlineAt,
	)
	if err != nil {
		return fmt.Errorf("insert Agent lifecycle operation: %w", err)
	}
	return nil
}

func (repository *Repository) insertAgentEvent(
	ctx context.Context, transaction *databaseTransaction, record ports.AgentEventRecord,
) error {
	payload, err := json.Marshal(record.Data)
	if err != nil {
		return fmt.Errorf("encode Agent event: %w", err)
	}
	var globalSequence int64
	if err := transaction.QueryRow(ctx, `
UPDATE agent_controller.event_journal_cursor
SET last_sequence = last_sequence + 1
WHERE singleton = TRUE
RETURNING last_sequence`).Scan(&globalSequence); err != nil {
		return fmt.Errorf("allocate Agent event sequence: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_events (
    global_sequence, event_id, agent_id, aggregate_sequence, schema_version, event_type,
    operation_request_id, trace_id, data, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		globalSequence, record.EventID, record.AgentID, record.AggregateSequence, record.SchemaVersion,
		record.EventType, record.OperationRequestID,
		record.TraceID, payload, record.OccurredAt,
	)
	if err != nil {
		return fmt.Errorf("insert Agent event: %w", err)
	}
	return nil
}

func (repository *Repository) recordEventAppend(ctx context.Context, eventType string) {
	if repository.eventAppended != nil {
		repository.eventAppended(ctx, eventType)
	}
}

func insertExecutionRevision(
	ctx context.Context, transaction *databaseTransaction, record ports.ExecutionRecord,
) error {
	changeSummary, err := json.Marshal(record.ChangeSummary)
	if err != nil {
		return fmt.Errorf("encode execution change summary: %w", err)
	}
	_, err = transaction.Exec(ctx, `
INSERT INTO agent_controller.execution_revisions (
    id, agent_id, revision, agent_spec_revision_id, runtime_revision,
    runtime_execution_id, runtime_mcp_endpoint, runtime_mcp_source_digest,
    change_summary, published_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		record.ID, record.AgentID, record.Revision, record.AgentSpecRevisionID,
		record.RuntimeRevision, record.RuntimeExecutionID, record.RuntimeMCPEndpoint,
		record.RuntimeMCPSourceDigest, changeSummary, record.PublishedAt,
	)
	if err != nil {
		return fmt.Errorf("insert execution revision: %w", err)
	}
	return nil
}

// Lifecycle completion owns the configured resource, not its later health.
func publishRuntimeTarget(
	ctx context.Context, transaction *databaseTransaction,
	operation ports.LifecycleOperationRecord, event ports.AgentEventRecord, now time.Time,
) error {
	if operation.RuntimeResult == nil || !provisionedRuntimeResult(*operation.RuntimeResult) ||
		operation.TargetSpecRevisionID == "" || event.AgentID != operation.AgentID ||
		event.OperationRequestID != operation.RequestID {
		return ports.ErrConcurrentChange
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET lifecycle_state = 'created', activation_state = 'enabled', runtime_state = 'unknown',
    runtime_reason = 'runtime_observation_pending', runtime_detail = '', runtime_observed_at = NULL,
    executable_spec_revision_id = $2,
    executable_execution_revision_id = '',
    runtime_revision = $3, runtime_execution_id = '', runtime_mcp_endpoint = '',
    active_operation_request_id = '', failure_stage = '', failure_code = '', failure_detail = '',
    aggregate_sequence = $4, updated_at = $5
WHERE id = $1 AND active_operation_request_id = $6 AND aggregate_sequence = $7`,
		operation.AgentID, operation.TargetSpecRevisionID, operation.RuntimeResult.RuntimeRevision,
		event.AggregateSequence, now, operation.RequestID, event.AggregateSequence-1,
	)
	if err != nil {
		return fmt.Errorf("publish configured Agent Runtime: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func loadAgentCreateState(
	ctx context.Context,
	queryer catalogQueryer,
	operation ports.LifecycleOperationRecord,
) (ports.AgentCreateState, error) {
	agent, err := loadAgentRecord(ctx, queryer, operation.AgentID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	access, err := loadOwnerAccess(ctx, queryer, operation.AgentID, agent.OwnerUserID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	spec, err := loadAgentSpec(ctx, queryer, operation.TargetSpecRevisionID)
	if err != nil {
		return ports.AgentCreateState{}, err
	}
	return ports.AgentCreateState{Agent: agent, Access: access, Spec: spec, Operation: operation}, nil
}

func loadAgentRecord(
	ctx context.Context, queryer catalogQueryer, agentID string,
) (ports.AgentRecord, error) {
	return scanAgentRecord(queryer.QueryRow(ctx, `
SELECT id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
       access_revision, executable_spec_revision_id, executable_execution_revision_id,
       last_successful_execution_revision_id, runtime_revision, runtime_execution_id,
       runtime_mcp_endpoint, active_operation_request_id, failure_stage, failure_code,
       failure_detail, aggregate_sequence, created_at, updated_at,
       owner_authorization_sequence, identity_revocation_sequence,
       activation_state, runtime_state, runtime_reason, runtime_detail, runtime_observed_at
FROM agent_controller.agents WHERE id = $1`, agentID))
}

func loadAgentRecordForUpdate(
	ctx context.Context, queryer catalogQueryer, agentID string,
) (ports.AgentRecord, error) {
	return scanAgentRecord(queryer.QueryRow(ctx, `
SELECT id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
       access_revision, executable_spec_revision_id, executable_execution_revision_id,
       last_successful_execution_revision_id, runtime_revision, runtime_execution_id,
       runtime_mcp_endpoint, active_operation_request_id, failure_stage, failure_code,
       failure_detail, aggregate_sequence, created_at, updated_at,
       owner_authorization_sequence, identity_revocation_sequence,
       activation_state, runtime_state, runtime_reason, runtime_detail, runtime_observed_at
FROM agent_controller.agents WHERE id = $1 FOR UPDATE`, agentID))
}

func scanAgentRecord(scanner lifecycleRowScanner) (ports.AgentRecord, error) {
	var record ports.AgentRecord
	err := scanner.Scan(
		&record.AgentID, &record.OrganizationID, &record.OwnerUserID, &record.Name,
		&record.DesiredState, &record.LifecycleState, &record.AccessRevision,
		&record.AgentSpecRevisionID, &record.ExecutionRevisionID,
		&record.LastSuccessfulExecutionRevisionID, &record.RuntimeRevision,
		&record.RuntimeExecutionID, &record.RuntimeMCPEndpoint,
		&record.ActiveOperationRequestID, &record.FailureStage, &record.FailureCode,
		&record.FailureDetail, &record.AggregateSequence, &record.CreatedAt, &record.UpdatedAt,
		&record.OwnerAuthorizationSequence, &record.IdentityRevocationSequence,
		&record.ActivationState, &record.RuntimeState, &record.RuntimeReason, &record.RuntimeDetail, &record.RuntimeObservedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AgentRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.AgentRecord{}, fmt.Errorf("load Agent projection: %w", err)
	}
	return record, nil
}

func loadOwnerAccess(
	ctx context.Context, queryer catalogQueryer, agentID string, ownerUserID string,
) (ports.AgentAccessRecord, error) {
	var record ports.AgentAccessRecord
	err := queryer.QueryRow(ctx, `
SELECT agent_id, principal_id, access_revision, active, created_at, updated_at
FROM agent_controller.agent_access_bindings
WHERE agent_id = $1 AND principal_id = $2`, agentID, ownerUserID).Scan(
		&record.AgentID, &record.PrincipalID,
		&record.AccessRevision, &record.Active, &record.CreatedAt, &record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AgentAccessRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.AgentAccessRecord{}, fmt.Errorf("load Agent access binding: %w", err)
	}
	return record, nil
}

func loadAgentSpec(
	ctx context.Context, queryer catalogQueryer, specID string,
) (ports.AgentSpecRecord, error) {
	var record ports.AgentSpecRecord
	var payload []byte
	err := queryer.QueryRow(ctx, `
SELECT id, agent_id, revision, snapshot, canonical_digest, created_at
FROM agent_controller.agent_spec_revisions WHERE id = $1`, specID).Scan(
		&record.ID, &record.AgentID, &record.Revision, &payload,
		&record.CanonicalDigest, &record.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AgentSpecRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.AgentSpecRecord{}, fmt.Errorf("load Agent spec revision: %w", err)
	}
	if err := json.Unmarshal(payload, &record.Snapshot); err != nil {
		return ports.AgentSpecRecord{}, fmt.Errorf("decode Agent spec revision: %w", err)
	}
	return record, nil
}

func loadLifecycleOperation(
	ctx context.Context,
	queryer catalogQueryer,
	requestID string,
	lockClause string,
) (ports.LifecycleOperationRecord, error) {
	query := `
SELECT request_id, request_fingerprint, agent_id, kind, phase, state,
	       source_spec_revision_id, source_execution_revision_id,
	       source_runtime_revision, source_runtime_absent,
	       target_spec_revision_id, child_request_id, network_attachment,
	       source_runtime_inspection,
	       source_runtime_absence_proof, runtime_result, network_release_outcome,
	       error_code, error_detail, retryable,
	       created_at, updated_at, owner_revocation_sequence, drain_deadline_at, settlement_outcome
FROM agent_controller.agent_lifecycle_operations
WHERE request_id = $1`
	if lockClause == "FOR UPDATE" {
		query += " FOR UPDATE"
	}
	return scanLifecycleOperation(queryer.QueryRow(ctx, query, requestID))
}

func scanLifecycleOperation(scanner lifecycleRowScanner) (ports.LifecycleOperationRecord, error) {
	var record ports.LifecycleOperationRecord
	var networkPayload, inspectionPayload, absenceProofPayload, runtimePayload []byte
	err := scanner.Scan(
		&record.RequestID, &record.RequestFingerprint, &record.AgentID,
		&record.Kind, &record.Phase, &record.State,
		&record.SourceSpecRevisionID, &record.SourceExecutionRevisionID,
		&record.SourceRuntimeRevision,
		&record.SourceRuntimeAbsent, &record.TargetSpecRevisionID,
		&record.ChildRequestID, &networkPayload,
		&inspectionPayload, &absenceProofPayload, &runtimePayload,
		&record.NetworkReleaseOutcome,
		&record.ErrorCode,
		&record.ErrorDetail, &record.Retryable, &record.CreatedAt, &record.UpdatedAt,
		&record.OwnerRevocationSequence,
		&record.DrainDeadlineAt, &record.SettlementOutcome,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LifecycleOperationRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("load Agent lifecycle operation: %w", err)
	}
	if record.DrainDeadlineAt != nil {
		deadline := record.DrainDeadlineAt.UTC()
		record.DrainDeadlineAt = &deadline
	}
	if len(networkPayload) != 0 {
		var attachment ports.NetworkAttachment
		if err := json.Unmarshal(networkPayload, &attachment); err != nil {
			return ports.LifecycleOperationRecord{}, fmt.Errorf("decode Agent network attachment: %w", err)
		}
		record.NetworkAttachment = &attachment
	}
	if len(inspectionPayload) != 0 {
		var inspection ports.RuntimeInspection
		if err := json.Unmarshal(inspectionPayload, &inspection); err != nil {
			return ports.LifecycleOperationRecord{}, fmt.Errorf("decode source Runtime inspection: %w", err)
		}
		record.SourceRuntimeInspection = &inspection
	}
	if len(absenceProofPayload) != 0 {
		var proof ports.RuntimeAbsenceProof
		if err := json.Unmarshal(absenceProofPayload, &proof); err != nil {
			return ports.LifecycleOperationRecord{}, fmt.Errorf("decode source Runtime absence proof: %w", err)
		}
		record.SourceRuntimeAbsenceProof = &proof
	}
	if len(runtimePayload) != 0 {
		var runtime ports.RuntimeOperation
		if err := json.Unmarshal(runtimePayload, &runtime); err != nil {
			return ports.LifecycleOperationRecord{}, fmt.Errorf("decode Runtime result: %w", err)
		}
		record.RuntimeResult = &runtime
	}
	return record, nil
}

var _ ports.AgentSpecSource = (*Repository)(nil)
var _ ports.LifecycleStore = (*Repository)(nil)
