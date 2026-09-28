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

func (repository *Repository) CompleteLegacySourceDrain(ctx context.Context, requestID, fingerprint string, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	return repository.advanceLegacySourceRecoveryPhase(ctx, requestID, fingerprint, "drain", "network_fence", now)
}

func (repository *Repository) advanceLegacySourceRecoveryPhase(ctx context.Context, requestID, fingerprint, from, to string, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if now.IsZero() {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacySourceRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err := loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State != "running" {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if record.Phase == to {
		return record, nil
	}
	if record.Phase != from {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_source_recoveries SET phase=$2,updated_at=$3 WHERE request_id=$1`, requestID, to, now); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err = loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	return record, tx.Commit(ctx)
}

func (repository *Repository) RecordLegacySourceFence(ctx context.Context, requestID, fingerprint string, closedAttachmentVersion uint64, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if closedAttachmentVersion == 0 || now.IsZero() {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacySourceRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err := loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State != "running" || closedAttachmentVersion < record.ObservedAttachmentVersion {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if record.Phase == "disable_runtime" {
		if record.ClosedAttachmentVersion != closedAttachmentVersion {
			return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return record, nil
	}
	if record.Phase != "network_fence" {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_source_recoveries SET phase='disable_runtime',closed_attachment_version=$2,updated_at=$3 WHERE request_id=$1`,
		requestID, closedAttachmentVersion, now); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err = loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	return record, tx.Commit(ctx)
}

func (repository *Repository) RecordLegacySourceRuntimeDisabled(ctx context.Context, requestID, fingerprint, childID string, result ports.RuntimeOperation, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if !disabledRuntimeResult(result) || now.IsZero() {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacySourceRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err := loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.ChildRequestID != childID || record.State != "running" {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if record.Phase == "publish" {
		if record.DisabledRuntimeResult == nil || *record.DisabledRuntimeResult != result {
			return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return record, nil
	}
	if record.Phase != "disable_runtime" || record.ClosedAttachmentVersion == 0 {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_source_recoveries SET phase='publish',disabled_runtime_revision=$2,disabled_runtime_result=$3,updated_at=$4 WHERE request_id=$1`,
		requestID, result.RuntimeRevision, payload, now); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err = loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	return record, tx.Commit(ctx)
}

func (repository *Repository) MarkLegacySourceManualRecovery(ctx context.Context, requestID, fingerprint, phase, reason string, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	valid := phase == "drain" && reason == "drain_not_settled" ||
		phase == "network_fence" && reason == "network_attachment_changed" ||
		phase == "disable_runtime" && reason == "runtime_disable_rejected" ||
		phase == "publish" && (reason == "network_attachment_changed" || reason == "publication_conflict")
	if !valid || now.IsZero() {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacySourceRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err := loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State == "manual_recovery_required" {
		if record.Phase != phase || record.ManualReason != reason {
			return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return record, nil
	}
	if record.State != "running" || record.Phase != phase {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_source_recoveries SET state='manual_recovery_required',error_code='legacy_source_manual_recovery_required',manual_reason=$2,updated_at=$3 WHERE request_id=$1`,
		requestID, reason, now); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err = loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	return record, tx.Commit(ctx)
}

func (repository *Repository) PublishLegacySourceRecovery(ctx context.Context, requestID, fingerprint string, closedAttachmentVersion uint64, eventID, traceID string, now time.Time) (ports.LegacySourceRecoveryRecord, error) {
	if eventID == "" || now.IsZero() {
		return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("invalid legacy source recovery publication")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLegacySourceRecovery(ctx, tx, requestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err := loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if record.Fingerprint != fingerprint {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrRequestConflict
	}
	if record.State == "completed" {
		return record, nil
	}
	if record.State != "running" || record.Phase != "publish" || record.DisabledRuntimeResult == nil ||
		!disabledRuntimeResult(*record.DisabledRuntimeResult) || record.DisabledRuntimeRevision != record.DisabledRuntimeResult.RuntimeRevision ||
		record.ClosedAttachmentVersion != closedAttachmentVersion {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, record.AgentID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, record.AgentID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if agent.OrganizationID != record.OrganizationID || agent.ActiveOperationRequestID != requestID ||
		agent.AggregateSequence != record.AdmittedAgentSequence || agent.AgentSpecRevisionID != record.SourceSpecRevisionID ||
		agent.RuntimeRevision != record.SourceRuntimeRevision || agent.FailureCode == "legacy_migration_proof_lost" ||
		agent.LifecycleState != domain.AgentCreated || agent.DesiredState != domain.DesiredEnabled ||
		agent.ActivationState != domain.ActivationEnabled {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	var marker string
	if err := tx.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`,
		record.AgentID, record.OrganizationID).Scan(&marker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
		}
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if marker != "pending" {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	retainedExecutionID, err := retainedLegacySourceExecution(ctx, tx, agent)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	sequence := agent.AggregateSequence + 1
	result, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET desired_state='disabled',activation_state='disabled',runtime_state='absent',runtime_reason='',runtime_detail='',runtime_observed_at=$3,
		executable_execution_revision_id='',last_successful_execution_revision_id=$4,runtime_revision=$2,runtime_execution_id='',runtime_mcp_endpoint='',
		active_operation_request_id='',failure_stage='',failure_code='',failure_detail='',aggregate_sequence=$5,updated_at=$3
		WHERE id=$1 AND active_operation_request_id=$6 AND aggregate_sequence=$7`,
		record.AgentID, record.DisabledRuntimeRevision, now, retainedExecutionID, sequence, requestID, agent.AggregateSequence)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("publish recovered legacy source: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{EventID: eventID, AgentID: record.AgentID,
		AggregateSequence: sequence, SchemaVersion: 1, EventType: ports.EventAgentLegacySourceRecovered,
		OperationRequestID: requestID, TraceID: traceID, OccurredAt: now,
		Data: map[string]any{"actor_principal_id": record.ActorPrincipalID, "source_runtime_revision": record.SourceRuntimeRevision,
			"disabled_runtime_revision": record.DisabledRuntimeRevision, "child_request_id": record.ChildRequestID}}); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.legacy_source_recoveries SET state='completed',phase='done',updated_at=$2 WHERE request_id=$1`, requestID, now); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if err := repository.advanceAgentExecutionRevision(ctx, tx, record.AgentID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, tx, record.OrganizationID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	record, err = loadLegacySourceRecovery(ctx, tx, requestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.LegacySourceRecoveryRecord{}, err
	}
	repository.recordEventAppend(ctx, ports.EventAgentLegacySourceRecovered)
	return record, nil
}

func retainedLegacySourceExecution(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord) (string, error) {
	execution, err := loadOptionalExecutionRevision(ctx, tx, agent.LastSuccessfulExecutionRevisionID)
	if errors.Is(err, ports.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if execution.ID == "" || execution.AgentID != agent.AgentID || execution.AgentSpecRevisionID != agent.AgentSpecRevisionID ||
		execution.RuntimeRevision != agent.RuntimeRevision {
		return "", nil
	}
	return execution.ID, nil
}

func lockLegacySourceRecovery(ctx context.Context, tx *databaseTransaction, requestID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT request_id FROM agent_controller.legacy_source_recoveries WHERE request_id=$1 FOR UPDATE`, requestID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	return err
}
