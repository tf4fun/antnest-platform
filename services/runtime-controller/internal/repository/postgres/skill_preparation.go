package postgres

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

// ResolvePreparedSkillSet is a read-only preflight. BeginTransition must repeat
// the same check and retain the selected materialization in its transaction;
// this read alone does not protect against a concurrent release or deletion.
func (r *Repository) ResolvePreparedSkillSet(ctx context.Context, reference skillset.PreparedReference) (skillset.PreparedMaterialization, error) {
	return resolvePreparedSkillSet(ctx, r.database, reference, false)
}

func resolvePreparedSkillSet(ctx context.Context, query preparationQuerier, reference skillset.PreparedReference, lock bool) (skillset.PreparedMaterialization, error) {
	computed, err := skillset.Digest(reference.OrganizationID, reference.LayoutVersion, reference.SystemSkills)
	if err != nil || computed != reference.SkillSetDigest || reference.Scope == "" || reference.AgentID == "" || !strings.HasPrefix(reference.ReferenceID, "psr_") {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	var result skillset.PreparedMaterialization
	var frozen []byte
	statement := `
SELECT s.set_id,s.controller_scope,s.organization_id,s.agent_id,s.skill_set_digest,s.layout_version,
       s.materialization,s.volume_name,s.manifest_digest,s.frozen_skills
FROM runtime_controller.skill_preparations p JOIN runtime_controller.skill_sets s ON s.set_id=p.set_id
WHERE p.reference_id=$1 AND NOT p.released AND s.state='ready'
  AND s.controller_scope=$2 AND s.organization_id=$3 AND s.agent_id=$4
	  AND s.skill_set_digest=$5 AND s.layout_version=$6`
	if lock {
		statement += " FOR SHARE OF p,s"
	}
	err = query.QueryRowContext(ctx, statement,
		reference.ReferenceID, reference.Scope, reference.OrganizationID, reference.AgentID, reference.SkillSetDigest, reference.LayoutVersion).Scan(
		&result.SetID, &result.Key.Scope, &result.Key.OrganizationID, &result.Key.AgentID, &result.Key.SkillSetDigest, &result.Key.LayoutVersion,
		&result.Key.Materialization, &result.VolumeName, &result.ManifestDigest, &frozen)
	if errors.Is(err, sql.ErrNoRows) {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	if err != nil {
		return skillset.PreparedMaterialization{}, fmt.Errorf("resolve prepared Skill reference: %w", err)
	}
	var stored []skillset.FrozenSkill
	if err := json.Unmarshal(frozen, &stored); err != nil {
		return skillset.PreparedMaterialization{}, err
	}
	storedDigest, err := skillset.Digest(result.Key.OrganizationID, result.Key.LayoutVersion, stored)
	if err != nil || storedDigest != reference.SkillSetDigest {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	volumeName, err := result.Key.VolumeName()
	if err != nil || volumeName != result.VolumeName || deployment.ValidateDigest(result.ManifestDigest) != nil {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	return result, nil
}

var _ repository.SkillPreparationStore = (*Repository)(nil)
var _ repository.PreparedSkillReferenceStore = (*Repository)(nil)
var _ repository.ReadySkillSetStore = (*Repository)(nil)

// MarkDriftedReadySkillVolume fences an owned but corrupt ready collection
// before the cleanup worker removes it. Existing logical preparation requests
// remain durable and will observe queued again after cleanup settles.
func (r *Repository) MarkDriftedReadySkillVolume(ctx context.Context, prepared skillset.PreparedMaterialization) error {
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var lifecycle string
	err = tx.QueryRowContext(ctx, `SELECT lifecycle_state FROM runtime_controller.runtime_environments WHERE agent_id=$1 FOR UPDATE`, prepared.Key.AgentID).Scan(&lifecycle)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	environmentErr := err
	var inFlight bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runtime_controller.operations WHERE agent_id=$1 AND state IN ('running','unknown'))`, prepared.Key.AgentID).Scan(&inFlight); err != nil {
		return err
	}
	if inFlight {
		return repository.ErrConcurrentMutation
	}
	var state, volumeName, manifestDigest string
	var materialization int64
	err = tx.QueryRowContext(ctx, `SELECT state,materialization,volume_name,manifest_digest FROM runtime_controller.skill_sets WHERE set_id=$1 AND controller_scope=$2 AND organization_id=$3 AND agent_id=$4 AND skill_set_digest=$5 AND layout_version=$6 FOR UPDATE`,
		prepared.SetID, prepared.Key.Scope, prepared.Key.OrganizationID, prepared.Key.AgentID, prepared.Key.SkillSetDigest, prepared.Key.LayoutVersion).Scan(&state, &materialization, &volumeName, &manifestDigest)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.ErrPreparedSkillSetInvalidated
	}
	if err != nil {
		return err
	}
	if state != string(skillset.PreparationReady) || materialization != prepared.Key.Materialization || volumeName != prepared.VolumeName || manifestDigest != prepared.ManifestDigest {
		return repository.ErrPreparedSkillSetInvalidated
	}
	var current, lifecycleReference bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runtime_controller.skill_current_references WHERE agent_id=$1 AND set_id=$2),EXISTS(SELECT 1 FROM runtime_controller.skill_lifecycle_references WHERE set_id=$2)`, prepared.Key.AgentID, prepared.SetID).Scan(&current, &lifecycleReference); err != nil {
		return err
	}
	if lifecycleReference || current && environmentErr == nil && lifecycle != string(deployment.LifecycleDisabled) && lifecycle != string(deployment.LifecycleDeleted) {
		return repository.ErrConcurrentMutation
	}
	if materialization >= 1_000_000_000 {
		return repository.ErrInvariantConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='cleanup_pending',lease_owner='',lease_until=NOW(),retry_after=NULL,error_code='skill_volume_drift',updated_at=NOW() WHERE set_id=$1`, prepared.SetID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// ResetMissingReadySkillVolume replaces a physically absent collection only
// when no active Runtime or accepted lifecycle operation references that set.
// A running source Runtime may use another set while the missing Rebuild target
// is rematerialized. Old operation/current-reference snapshots stay immutable.
func (r *Repository) ResetMissingReadySkillVolume(ctx context.Context, prepared skillset.PreparedMaterialization) error {
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var lifecycle string
	err = tx.QueryRowContext(ctx, `SELECT lifecycle_state FROM runtime_controller.runtime_environments WHERE agent_id=$1 FOR UPDATE`, prepared.Key.AgentID).Scan(&lifecycle)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	environmentErr := err
	var inFlight bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runtime_controller.operations WHERE agent_id=$1 AND state IN ('running','unknown'))`, prepared.Key.AgentID).Scan(&inFlight); err != nil {
		return err
	}
	if inFlight {
		return repository.ErrConcurrentMutation
	}
	var state, volumeName, manifestDigest string
	var materialization int64
	err = tx.QueryRowContext(ctx, `SELECT state,materialization,volume_name,manifest_digest FROM runtime_controller.skill_sets WHERE set_id=$1 AND controller_scope=$2 AND organization_id=$3 AND agent_id=$4 AND skill_set_digest=$5 AND layout_version=$6 FOR UPDATE`,
		prepared.SetID, prepared.Key.Scope, prepared.Key.OrganizationID, prepared.Key.AgentID, prepared.Key.SkillSetDigest, prepared.Key.LayoutVersion).Scan(&state, &materialization, &volumeName, &manifestDigest)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.ErrPreparedSkillSetInvalidated
	}
	if err != nil {
		return err
	}
	if state != string(skillset.PreparationReady) || materialization != prepared.Key.Materialization || volumeName != prepared.VolumeName || manifestDigest != prepared.ManifestDigest {
		return repository.ErrPreparedSkillSetInvalidated
	}
	if environmentErr == nil && lifecycle != string(deployment.LifecycleDisabled) && lifecycle != string(deployment.LifecycleDeleted) {
		var current, lifecycleReference bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runtime_controller.skill_current_references WHERE agent_id=$1 AND set_id=$2),EXISTS(SELECT 1 FROM runtime_controller.skill_lifecycle_references WHERE set_id=$2)`, prepared.Key.AgentID, prepared.SetID).Scan(&current, &lifecycleReference); err != nil {
			return err
		}
		if current || lifecycleReference {
			return repository.ErrConcurrentMutation
		}
	}
	if materialization >= 1_000_000_000 {
		return repository.ErrInvariantConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1`, prepared.SetID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='queued',verified_packages=0,verified_bytes=0,materialization=materialization+1,volume_name='',manifest_digest='',lease_owner='',lease_until=NULL,retry_after=NULL,error_code='skill_volume_missing',updated_at=$2 WHERE set_id=$1`, prepared.SetID, time.Now().UTC()); err != nil {
		return err
	}
	return tx.Commit()
}

// AdmitSkillPreparation records an intent independently of Environment and
// lifecycle mutation locks. It does not perform downloads or Docker I/O.
func (r *Repository) AdmitSkillPreparation(ctx context.Context, input skillset.PrepareRequest) (skillset.PreparationReceipt, error) {
	fingerprint, err := input.ValidateAndDigest()
	if err != nil {
		return skillset.PreparationReceipt{}, err
	}
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("begin Skill preparation admission: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var existing string
	err = tx.QueryRowContext(ctx, `SELECT request_digest FROM runtime_controller.skill_preparations WHERE request_id=$1`, input.RequestID).Scan(&existing)
	if err == nil {
		if existing != fingerprint {
			return skillset.PreparationReceipt{}, repository.ErrIdempotencyConflict
		}
		value, err := readSkillPreparation(ctx, tx, input.Scope, input.OrganizationID, input.AgentID, input.RequestID)
		if err != nil {
			return skillset.PreparationReceipt{}, err
		}
		if err := tx.Commit(); err != nil {
			return skillset.PreparationReceipt{}, fmt.Errorf("commit Skill preparation replay: %w", err)
		}
		return value, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return skillset.PreparationReceipt{}, fmt.Errorf("read Skill preparation receipt: %w", err)
	}
	var lifecycle, activeKind string
	err = tx.QueryRowContext(ctx, `
SELECT e.lifecycle_state,COALESCE(o.kind,'') FROM runtime_controller.runtime_environments e
LEFT JOIN runtime_controller.operations o ON o.request_id=e.operation_id
WHERE e.agent_id=$1 FOR UPDATE OF e`, input.AgentID).Scan(&lifecycle, &activeKind)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return skillset.PreparationReceipt{}, fmt.Errorf("read Agent Skill preparation admission: %w", err)
	}
	if lifecycle == string(deployment.LifecycleDeleting) || lifecycle == string(deployment.LifecycleDeleted) || activeKind == string(deployment.OperationDeleteRuntime) {
		return skillset.PreparationReceipt{}, repository.ErrSkillPreparationClosed
	}
	// No Environment is created. All requests for one exact collection share
	// a single materialization, while each owner receives a distinct reference.
	frozen, err := json.Marshal(input.SystemSkills)
	if err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("encode frozen Skills: %w", err)
	}
	var totalBytes int64
	for _, skill := range input.SystemSkills {
		totalBytes += skill.UnpackedSize
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO runtime_controller.skill_sets
  (controller_scope,organization_id,agent_id,skill_set_digest,layout_version,frozen_skills,state,total_packages,total_bytes)
VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)
ON CONFLICT (controller_scope,organization_id,agent_id,skill_set_digest,layout_version) DO NOTHING`,
		input.Scope, input.OrganizationID, input.AgentID, input.SkillSetDigest, input.LayoutVersion, frozen,
		len(input.SystemSkills), totalBytes)
	if err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("record Skill set: %w", err)
	}
	var setID int64
	var setState, volumeName string
	if err := tx.QueryRowContext(ctx, `
SELECT set_id,state,volume_name FROM runtime_controller.skill_sets
WHERE controller_scope=$1 AND organization_id=$2 AND agent_id=$3 AND skill_set_digest=$4 AND layout_version=$5 FOR UPDATE`,
		input.Scope, input.OrganizationID, input.AgentID, input.SkillSetDigest, input.LayoutVersion).Scan(&setID, &setState, &volumeName); err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("read Skill set identity: %w", err)
	}
	if setState == string(skillset.PreparationCleanupPending) || setState == string(skillset.PreparationInvalidated) && volumeName != "" {
		return skillset.PreparationReceipt{}, repository.ErrSkillCleanupInProgress
	}
	if setState == string(skillset.PreparationInvalidated) {
		if _, err := tx.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='queued',error_code='',retry_after=NULL,updated_at=NOW() WHERE set_id=$1`, setID); err != nil {
			return skillset.PreparationReceipt{}, fmt.Errorf("requeue collected Skill set: %w", err)
		}
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("generate Skill reference: %w", err)
	}
	referenceID := "psr_" + hex.EncodeToString(random[:])
	result, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.skill_preparations
  (request_id,request_digest,set_id,owner_operation_id,reference_id)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (request_id) DO NOTHING`, input.RequestID, fingerprint, setID, input.OwnerOperationID, referenceID)
	if err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("record Skill preparation receipt: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return skillset.PreparationReceipt{}, err
	}
	if inserted == 0 {
		if err := tx.QueryRowContext(ctx, `SELECT request_digest FROM runtime_controller.skill_preparations WHERE request_id=$1`, input.RequestID).Scan(&existing); err != nil {
			return skillset.PreparationReceipt{}, fmt.Errorf("read concurrent Skill preparation receipt: %w", err)
		}
		if existing != fingerprint {
			return skillset.PreparationReceipt{}, repository.ErrIdempotencyConflict
		}
	}
	value, err := readSkillPreparation(ctx, tx, input.Scope, input.OrganizationID, input.AgentID, input.RequestID)
	if err != nil {
		return skillset.PreparationReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("commit Skill preparation admission: %w", err)
	}
	return value, nil
}

func (r *Repository) GetSkillPreparation(ctx context.Context, scope, organizationID, agentID, requestID string) (skillset.PreparationReceipt, error) {
	return readSkillPreparation(ctx, r.database, scope, organizationID, agentID, requestID)
}

type preparationQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readSkillPreparation(ctx context.Context, query preparationQuerier, scope, organizationID, agentID, requestID string) (skillset.PreparationReceipt, error) {
	var value skillset.PreparationReceipt
	var digest, referenceID, state string
	var layout uint32
	var released bool
	var retryAfter sql.NullTime
	err := query.QueryRowContext(ctx, `
SELECT p.request_id,s.agent_id,s.organization_id,p.owner_operation_id,s.state,
       s.verified_packages,s.verified_bytes,s.total_packages,s.total_bytes,
       s.skill_set_digest,s.layout_version,p.reference_id,p.released,s.retry_after,s.error_code
FROM runtime_controller.skill_preparations p JOIN runtime_controller.skill_sets s ON s.set_id=p.set_id
WHERE p.request_id=$1 AND s.controller_scope=$2 AND s.organization_id=$3 AND s.agent_id=$4`,
		requestID, scope, organizationID, agentID).Scan(
		&value.RequestID, &value.AgentID, &value.OrganizationID, &value.OwnerOperationID, &state,
		&value.Progress.VerifiedPackages, &value.Progress.VerifiedBytes, &value.Progress.TotalPackages, &value.Progress.TotalBytes,
		&digest, &layout, &referenceID, &released, &retryAfter, &value.ErrorCode)
	if errors.Is(err, sql.ErrNoRows) {
		return skillset.PreparationReceipt{}, repository.ErrNotFound
	}
	if err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("read Skill preparation: %w", err)
	}
	value.State = skillset.PreparationState(state)
	if retryAfter.Valid {
		value.RetryAfter = &retryAfter.Time
	}
	if value.State == skillset.PreparationReady && !released {
		value.PreparedSkillSet = &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: layout}
		value.PreparedReferenceID = referenceID
	}
	return value, nil
}

func (r *Repository) ReleaseSkillPreparation(ctx context.Context, scope, organizationID, agentID, requestID, ownerOperationID string) error {
	result, err := r.database.ExecContext(ctx, `
UPDATE runtime_controller.skill_preparations p SET released=TRUE, updated_at=NOW()
FROM runtime_controller.skill_sets s
WHERE p.set_id=s.set_id AND p.request_id=$1 AND s.controller_scope=$2
  AND s.organization_id=$3 AND s.agent_id=$4 AND p.owner_operation_id=$5`,
		requestID, scope, organizationID, agentID, ownerOperationID)
	if err != nil {
		return fmt.Errorf("release Skill preparation: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return repository.ErrNotFound
	}
	return nil
}
