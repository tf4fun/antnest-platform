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

func (repository *Repository) BeginLegacySourceRecovery(ctx context.Context, input ports.BeginLegacySourceRecovery) (ports.LegacySourceRecoveryRecord, bool, error) {
	if input.RequestID == "" || !proofLossFingerprintPattern.MatchString(input.Fingerprint) ||
		input.AgentID == "" || input.OrganizationID == "" || input.ActorPrincipalID == "" {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("invalid legacy source recovery admission")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("begin legacy source recovery transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockLifecycleRequest(ctx, tx, input.RequestID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	existing, err := loadLegacySourceRecovery(ctx, tx, input.RequestID)
	if err == nil {
		if existing.Fingerprint != input.Fingerprint || existing.AgentID != input.AgentID ||
			existing.OrganizationID != input.OrganizationID || existing.ActorPrincipalID != input.ActorPrincipalID {
			return ports.LegacySourceRecoveryRecord{}, false, ports.ErrRequestConflict
		}
		return existing, true, nil
	}
	if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if input.SourceSpecRevisionID == "" || input.SourceRuntimeRevision == "" || input.ObservedRuntimeExecutionID == "" ||
		input.ObservedAttachmentVersion == 0 || input.ExpectedAggregateSequence < 1 || input.ChildRequestID == "" ||
		input.Now.IsZero() || !input.DrainDeadlineAt.After(input.Now) {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("invalid legacy source recovery observation")
	}
	if _, err := loadLifecycleOperation(ctx, tx, input.RequestID, ""); err == nil {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrRequestConflict
	} else if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if _, err := loadLegacyProofLossRecovery(ctx, tx, input.RequestID); err == nil {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrRequestConflict
	} else if !errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, input.AgentID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, input.AgentID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if agent.OrganizationID != input.OrganizationID || agent.ActiveOperationRequestID != "" ||
		agent.AggregateSequence != input.ExpectedAggregateSequence || agent.AgentSpecRevisionID != input.SourceSpecRevisionID ||
		agent.RuntimeRevision != input.SourceRuntimeRevision || agent.FailureCode == "legacy_migration_proof_lost" ||
		agent.LifecycleState != domain.AgentCreated || agent.DesiredState != domain.DesiredEnabled ||
		agent.ActivationState != domain.ActivationEnabled {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	var marker string
	if err := tx.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`,
		input.AgentID, input.OrganizationID).Scan(&marker); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.LegacySourceRecoveryRecord{}, false, ports.ErrConcurrentChange
		}
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("check legacy source recovery marker: %w", err)
	}
	if marker != "pending" {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	unproven, err := legacyRecoverySourceUnproven(ctx, tx, agent)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if !unproven {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.legacy_source_recoveries
		(request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,admitted_agent_sequence,source_spec_revision_id,
		source_runtime_revision,observed_runtime_execution_id,observed_attachment_version,child_request_id,
		drain_deadline_at,state,phase,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'running','drain',$13,$13)`,
		input.RequestID, input.Fingerprint, input.AgentID, input.OrganizationID, input.ActorPrincipalID,
		input.ExpectedAggregateSequence+1,
		input.SourceSpecRevisionID, input.SourceRuntimeRevision, input.ObservedRuntimeExecutionID,
		input.ObservedAttachmentVersion, input.ChildRequestID, input.DrainDeadlineAt, input.Now)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("insert legacy source recovery: %w", err)
	}
	result, err := tx.Exec(ctx, `UPDATE agent_controller.agents
		SET active_operation_request_id=$2,aggregate_sequence=aggregate_sequence+1,updated_at=$3
		WHERE id=$1 AND active_operation_request_id='' AND aggregate_sequence=$4`,
		input.AgentID, input.RequestID, input.Now, input.ExpectedAggregateSequence)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("reserve legacy source recovery Agent: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.LegacySourceRecoveryRecord{}, false, ports.ErrConcurrentChange
	}
	if err := repository.advanceAgentExecutionRevision(ctx, tx, input.AgentID); err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	stored, err := loadLegacySourceRecovery(ctx, tx, input.RequestID)
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.LegacySourceRecoveryRecord{}, false, fmt.Errorf("commit legacy source recovery: %w", err)
	}
	return stored, false, nil
}

func legacyRecoverySourceUnproven(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord) (bool, error) {
	spec, err := loadAgentSpec(ctx, tx, agent.AgentSpecRevisionID)
	if err != nil || spec.AgentID != agent.AgentID {
		if errors.Is(err, ports.ErrNotFound) || err == nil {
			return false, ports.ErrConcurrentChange
		}
		return false, err
	}
	executionID := agent.ExecutionRevisionID
	if executionID == "" {
		executionID = agent.LastSuccessfulExecutionRevisionID
	}
	execution, err := loadOptionalExecutionRevision(ctx, tx, executionID)
	if errors.Is(err, ports.ErrNotFound) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	nextSpec, nextExecution, err := loadNextLifecycleRevisions(ctx, tx, agent.AgentID)
	if err != nil {
		return false, err
	}
	proven := agent.AgentSpecRevisionID != "" && agent.RuntimeRevision != "" &&
		ports.AgentRuntimeSource{Spec: spec, Execution: execution}.MatchesAgent(agent) &&
		nextSpec > spec.Revision && nextExecution > execution.Revision
	return !proven, nil
}

func (repository *Repository) GetLegacySourceRecovery(ctx context.Context, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	return loadLegacySourceRecovery(ctx, repository.pool, requestID)
}

func loadLegacySourceRecovery(ctx context.Context, query catalogQueryer, requestID string) (ports.LegacySourceRecoveryRecord, error) {
	var record ports.LegacySourceRecoveryRecord
	var observed, closed int64
	var disabledPayload []byte
	err := query.QueryRow(ctx, `SELECT request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,admitted_agent_sequence,
		source_spec_revision_id,source_runtime_revision,observed_runtime_execution_id,observed_attachment_version,
		closed_attachment_version,child_request_id,drain_deadline_at,disabled_runtime_revision,disabled_runtime_result,state,phase,error_code,
		manual_reason,created_at,updated_at FROM agent_controller.legacy_source_recoveries WHERE request_id=$1`, requestID).
		Scan(&record.RequestID, &record.Fingerprint, &record.AgentID, &record.OrganizationID, &record.ActorPrincipalID,
			&record.AdmittedAgentSequence, &record.SourceSpecRevisionID, &record.SourceRuntimeRevision, &record.ObservedRuntimeExecutionID, &observed,
			&closed, &record.ChildRequestID, &record.DrainDeadlineAt, &record.DisabledRuntimeRevision, &disabledPayload, &record.State,
			&record.Phase, &record.ErrorCode, &record.ManualReason, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySourceRecoveryRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("load legacy source recovery: %w", err)
	}
	record.ObservedAttachmentVersion = uint64(observed)
	record.ClosedAttachmentVersion = uint64(closed)
	if len(disabledPayload) > 0 {
		var result ports.RuntimeOperation
		if err := json.Unmarshal(disabledPayload, &result); err != nil {
			return ports.LegacySourceRecoveryRecord{}, fmt.Errorf("decode legacy source disabled Runtime result: %w", err)
		}
		record.DisabledRuntimeResult = &result
	}
	return record, nil
}
