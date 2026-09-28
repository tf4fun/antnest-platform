package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var proofLossFingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (repository *Repository) BeginLegacyProofLossRecovery(ctx context.Context, input ports.BeginLegacyProofLossRecovery) (ports.LegacyProofLossRecoveryRecord, bool, error) {
	if input.RequestID == "" || !proofLossFingerprintPattern.MatchString(input.Fingerprint) ||
		input.AgentID == "" || input.OrganizationID == "" || input.ActorPrincipalID == "" ||
		input.FailedMigrationRequestID == "" {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("invalid legacy proof-loss recovery admission")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("begin legacy proof-loss recovery transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, transaction, input.RequestID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	existing, err := loadLegacyProofLossRecovery(ctx, transaction, input.RequestID)
	if err == nil {
		if existing.Fingerprint != input.Fingerprint || existing.AgentID != input.AgentID ||
			existing.OrganizationID != input.OrganizationID || existing.ActorPrincipalID != input.ActorPrincipalID ||
			existing.FailedMigrationRequestID != input.FailedMigrationRequestID {
			return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrRequestConflict
		}
		return existing, true, nil
	}
	if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	if input.TargetRuntimeRevision == "" || input.ObservedRuntimeExecutionID == "" ||
		input.ClosedAttachmentVersion == 0 || input.ExpectedAggregateSequence < 1 ||
		input.ChildRequestID == "" || input.Now.IsZero() {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("invalid legacy proof-loss recovery observation")
	}
	if _, err := loadLifecycleOperation(ctx, transaction, input.RequestID, ""); err == nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrRequestConflict
	} else if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	if err := lockAgentExecutionConfiguration(ctx, transaction, input.AgentID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, input.AgentID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	if agent.OrganizationID != input.OrganizationID || agent.ActiveOperationRequestID != "" ||
		agent.AggregateSequence != input.ExpectedAggregateSequence || agent.FailureCode != "legacy_migration_proof_lost" ||
		agent.LifecycleState != domain.AgentCreated || agent.DesiredState != domain.DesiredEnabled ||
		agent.ActivationState != domain.ActivationEnabled || agent.ExecutionRevisionID != "" {
		return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	var marker string
	if err := transaction.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`,
		input.AgentID, input.OrganizationID).Scan(&marker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrConcurrentChange
		}
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("check legacy recovery marker: %w", err)
	}
	if marker != "pending" {
		return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	failed, err := loadLifecycleOperation(ctx, transaction, input.FailedMigrationRequestID, "")
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	if failed.AgentID != input.AgentID || failed.State != domain.OperationFailed ||
		(failed.Kind != domain.OperationRebuild && failed.Kind != domain.OperationEnable) ||
		failed.Phase != domain.PhasePublish || failed.ErrorCode != "legacy_migration_proof_lost" ||
		failed.RuntimeResult == nil || failed.RuntimeResult.State != "completed" ||
		failed.RuntimeResult.Effect != "completed" || failed.RuntimeResult.LifecycleState != "provisioned" ||
		failed.RuntimeResult.RuntimeRevision != input.TargetRuntimeRevision {
		return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	_, err = transaction.Exec(ctx, `INSERT INTO agent_controller.legacy_proof_loss_recoveries
		(request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,failed_migration_request_id,
		target_runtime_revision,observed_runtime_execution_id,closed_attachment_version,child_request_id,state,phase,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running','disable_runtime',$11,$11)`,
		input.RequestID, input.Fingerprint, input.AgentID, input.OrganizationID, input.ActorPrincipalID,
		input.FailedMigrationRequestID, input.TargetRuntimeRevision, input.ObservedRuntimeExecutionID,
		input.ClosedAttachmentVersion, input.ChildRequestID, input.Now)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("insert legacy proof-loss recovery: %w", err)
	}
	result, err := transaction.Exec(ctx, `UPDATE agent_controller.agents
		SET active_operation_request_id=$2,aggregate_sequence=aggregate_sequence+1,updated_at=$3
		WHERE id=$1 AND active_operation_request_id='' AND aggregate_sequence=$4 AND failure_code='legacy_migration_proof_lost'`,
		input.AgentID, input.RequestID, input.Now, input.ExpectedAggregateSequence)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("reserve legacy proof-loss Agent: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LegacyProofLossRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	if err := repository.advanceAgentExecutionRevision(ctx, transaction, input.AgentID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	stored, err := loadLegacyProofLossRecovery(ctx, transaction, input.RequestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, false, fmt.Errorf("commit legacy proof-loss recovery: %w", err)
	}
	return stored, false, nil
}

func (repository *Repository) GetLegacyProofLossRecovery(ctx context.Context, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
	return loadLegacyProofLossRecovery(ctx, repository.pool, requestID)
}

// RecordLegacyProofLossRuntimeDisabled persists the exact RC child receipt
// before publication. A retry cannot substitute a different RC result.
func (repository *Repository) RecordLegacyProofLossRuntimeDisabled(ctx context.Context, requestID, fingerprint, childID string, result ports.RuntimeOperation, now time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	if !disabledRuntimeResult(result) || now.IsZero() {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacyProofLossRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	record, err := loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.ChildRequestID != childID {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if record.State == "manual_recovery_required" {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if record.Phase != "disable_runtime" {
		if record.DisabledRuntimeResult == nil || *record.DisabledRuntimeResult != result {
			return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return record, nil
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_proof_loss_recoveries SET phase='publish',disabled_runtime_revision=$2,disabled_runtime_result=$3,updated_at=$4 WHERE request_id=$1`, requestID, result.RuntimeRevision, payload, now); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("record disabled Runtime: %w", err)
	}
	record, err = loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	return record, nil
}

func (repository *Repository) MarkLegacyProofLossManualRecovery(ctx context.Context, requestID, fingerprint, phase, reason string, now time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	if (phase != "disable_runtime" && phase != "publish") ||
		(reason != "runtime_disable_rejected" && reason != "network_attachment_changed" && reason != "publication_conflict") || now.IsZero() {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacyProofLossRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	record, err := loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State == "manual_recovery_required" {
		if record.Phase != phase || record.ManualReason != reason {
			return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return record, nil
	}
	if record.State != "running" || record.Phase != phase {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_proof_loss_recoveries SET state='manual_recovery_required',error_code='legacy_migration_manual_recovery_required',manual_reason=$2,updated_at=$3 WHERE request_id=$1`, requestID, reason, now); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("mark legacy recovery for manual intervention: %w", err)
	}
	record, err = loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	return record, nil
}

// PublishLegacyProofLossRecovery requires the caller to have freshly checked
// closed Egress and to supply the admission attachment version it observed.
func (repository *Repository) PublishLegacyProofLossRecovery(ctx context.Context, requestID, fingerprint string, closedAttachmentVersion uint64, eventID, traceID string, now time.Time) (ports.LegacyProofLossRecoveryRecord, error) {
	if eventID == "" || now.IsZero() {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("invalid legacy proof-loss publication")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacyProofLossRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	record, err := loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State == "completed" {
		return record, nil
	}
	if record.State != "running" || record.Phase != "publish" || record.DisabledRuntimeResult == nil || !disabledRuntimeResult(*record.DisabledRuntimeResult) ||
		record.DisabledRuntimeRevision != record.DisabledRuntimeResult.RuntimeRevision || record.ClosedAttachmentVersion != closedAttachmentVersion {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, record.AgentID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, record.AgentID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if agent.OrganizationID != record.OrganizationID || agent.ActiveOperationRequestID != requestID ||
		agent.FailureCode != "legacy_migration_proof_lost" || agent.LifecycleState != domain.AgentCreated ||
		agent.DesiredState != domain.DesiredEnabled || agent.ActivationState != domain.ActivationEnabled || agent.ExecutionRevisionID != "" {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	var marker string
	if err := tx.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`, record.AgentID, record.OrganizationID).Scan(&marker); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("check legacy recovery marker: %w", err)
	}
	if marker != "pending" {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	failed, err := loadLifecycleOperation(ctx, tx, record.FailedMigrationRequestID, "")
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if failed.AgentID != record.AgentID || failed.State != domain.OperationFailed || failed.Phase != domain.PhasePublish ||
		failed.ErrorCode != "legacy_migration_proof_lost" || failed.RuntimeResult == nil || failed.RuntimeResult.RuntimeRevision != record.TargetRuntimeRevision {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	sequence := agent.AggregateSequence + 1
	result, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET desired_state='disabled',activation_state='disabled',runtime_state='absent',runtime_reason='',runtime_detail='',runtime_observed_at=$3,
		executable_execution_revision_id='',runtime_revision=$2,runtime_execution_id='',runtime_mcp_endpoint='',active_operation_request_id='',
		failure_stage='',failure_code='',failure_detail='',aggregate_sequence=$4,updated_at=$3 WHERE id=$1 AND active_operation_request_id=$5 AND aggregate_sequence=$6`,
		record.AgentID, record.DisabledRuntimeRevision, now, sequence, requestID, agent.AggregateSequence)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("publish recovered Agent: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{EventID: eventID, AgentID: record.AgentID, AggregateSequence: sequence, SchemaVersion: 1,
		EventType: ports.EventAgentLegacyProofLossRecovered, OperationRequestID: requestID, TraceID: traceID,
		Data: map[string]any{"failed_migration_request_id": record.FailedMigrationRequestID, "actor_principal_id": record.ActorPrincipalID,
			"target_runtime_revision": record.TargetRuntimeRevision, "disabled_runtime_revision": record.DisabledRuntimeRevision, "child_request_id": record.ChildRequestID}, OccurredAt: now}); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_proof_loss_recoveries SET state='completed',phase='done',updated_at=$2 WHERE request_id=$1`, requestID, now); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if err := repository.advanceAgentExecutionRevision(ctx, tx, record.AgentID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, tx, record.OrganizationID); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	record, err = loadLegacyProofLossRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, err
	}
	repository.recordEventAppend(ctx, ports.EventAgentLegacyProofLossRecovered)
	return record, nil
}

func lockLegacyProofLossRecovery(ctx context.Context, tx *databaseTransaction, requestID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT request_id FROM agent_controller.legacy_proof_loss_recoveries WHERE request_id=$1 FOR UPDATE`, requestID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	return err
}

func loadLegacyProofLossRecovery(ctx context.Context, query catalogQueryer, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
	var record ports.LegacyProofLossRecoveryRecord
	var attachmentVersion int64
	var disabledPayload []byte
	err := query.QueryRow(ctx, `SELECT request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,
		failed_migration_request_id,target_runtime_revision,observed_runtime_execution_id,closed_attachment_version,
		child_request_id,disabled_runtime_revision,disabled_runtime_result,state,phase,error_code,manual_reason,created_at,updated_at
		FROM agent_controller.legacy_proof_loss_recoveries WHERE request_id=$1`, requestID).
		Scan(&record.RequestID, &record.Fingerprint, &record.AgentID, &record.OrganizationID, &record.ActorPrincipalID,
			&record.FailedMigrationRequestID, &record.TargetRuntimeRevision, &record.ObservedRuntimeExecutionID,
			&attachmentVersion, &record.ChildRequestID, &record.DisabledRuntimeRevision, &disabledPayload, &record.State, &record.Phase, &record.ErrorCode, &record.ManualReason, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacyProofLossRecoveryRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("load legacy proof-loss recovery: %w", err)
	}
	record.ClosedAttachmentVersion = uint64(attachmentVersion)
	if len(disabledPayload) > 0 {
		var result ports.RuntimeOperation
		if err := json.Unmarshal(disabledPayload, &result); err != nil {
			return ports.LegacyProofLossRecoveryRecord{}, fmt.Errorf("decode disabled Runtime receipt: %w", err)
		}
		record.DisabledRuntimeResult = &result
	}
	return record, nil
}
