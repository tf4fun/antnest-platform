package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

var _ repository.SkillPreparationWorkerStore = (*Repository)(nil)

const skillClaimLockID int64 = 0x41544e53534b4c4d

// ClaimSkillPreparation serializes the global concurrency budget across RC
// replicas, then leases one persistent set. Expired leases retain package
// checkpoints and the same physical volume identity.
func (r *Repository) ClaimSkillPreparation(ctx context.Context, scope, worker string, now time.Time, lease time.Duration, capacity int) (*skillset.PreparationJob, error) {
	if scope == "" || worker == "" || lease <= 0 || capacity < 1 {
		return nil, fmt.Errorf("invalid Skill preparation worker claim")
	}
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin Skill preparation claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, skillClaimLockID); err != nil {
		return nil, fmt.Errorf("lock Skill preparation capacity: %w", err)
	}
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_sets WHERE state='preparing' AND lease_until>$1`, now).Scan(&active); err != nil {
		return nil, err
	}
	if active >= capacity {
		return nil, nil
	}
	var job skillset.PreparationJob
	var frozen []byte
	err = tx.QueryRowContext(ctx, `
SELECT s.set_id,s.controller_scope,s.organization_id,s.agent_id,s.skill_set_digest,s.layout_version,
       s.materialization,s.volume_name,s.frozen_skills
FROM runtime_controller.skill_sets s
WHERE s.controller_scope=$1
  AND (s.state='queued' OR s.state='retry_wait' AND s.retry_after<=$2 OR s.state='preparing' AND s.lease_until<=$2)
  AND EXISTS (SELECT 1 FROM runtime_controller.skill_preparations p WHERE p.set_id=s.set_id AND NOT p.released)
ORDER BY s.created_at,s.set_id
LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, scope, now).Scan(&job.SetID, &job.Key.Scope, &job.Key.OrganizationID, &job.Key.AgentID,
		&job.Key.SkillSetDigest, &job.Key.LayoutVersion, &job.Key.Materialization, &job.VolumeName, &frozen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select Skill preparation set: %w", err)
	}
	if err := json.Unmarshal(frozen, &job.Skills); err != nil {
		return nil, fmt.Errorf("decode frozen Skill set: %w", err)
	}
	if job.Key.Materialization == 0 {
		job.Key.Materialization = 1
	}
	if job.VolumeName == "" {
		job.VolumeName, err = job.Key.VolumeName()
		if err != nil {
			return nil, err
		}
	}
	_, err = tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets
SET state='preparing',lease_owner=$2,lease_until=$3,materialization=$4,volume_name=$5,retry_after=NULL,error_code='',updated_at=$6
WHERE set_id=$1`, job.SetID, worker, now.Add(lease), job.Key.Materialization, job.VolumeName, now)
	if err != nil {
		return nil, fmt.Errorf("claim Skill preparation set: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
SELECT skill_id,version,content_digest,verified_bytes,files
FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1 ORDER BY skill_id`, job.SetID)
	if err != nil {
		return nil, fmt.Errorf("read Skill checkpoints: %w", err)
	}
	for rows.Next() {
		var checkpoint skillset.PackageCheckpoint
		var encoded []byte
		if err := rows.Scan(&checkpoint.SkillID, &checkpoint.Version, &checkpoint.ContentDigest, &checkpoint.VerifiedBytes, &encoded); err != nil {
			_ = rows.Close()
			return nil, err
		}
		var stored struct {
			Files       []skillset.PackageFile `json:"files"`
			Directories []string               `json:"directories"`
		}
		if err := json.Unmarshal(encoded, &stored); err != nil {
			_ = rows.Close()
			return nil, err
		}
		checkpoint.Files, checkpoint.Directories = stored.Files, stored.Directories
		job.Checkpoints = append(job.Checkpoints, checkpoint)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit Skill preparation claim: %w", err)
	}
	return &job, nil
}

func (r *Repository) RenewSkillPreparation(ctx context.Context, setID int64, worker string, now time.Time, lease time.Duration) error {
	if lease <= 0 {
		return fmt.Errorf("invalid Skill lease duration")
	}
	result, err := r.database.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets SET lease_until=$4,updated_at=$3
WHERE set_id=$1 AND lease_owner=$2 AND state='preparing' AND lease_until>$3`, setID, worker, now, now.Add(lease))
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return repository.ErrLockLost
	}
	return nil
}

func (r *Repository) CheckpointSkillPackage(ctx context.Context, setID int64, worker string, skill skillset.FrozenSkill, pkg skillset.Package, now time.Time) error {
	if pkg.Name != skill.Name || pkg.Description != skill.Description || pkg.ContentDigest != skill.ContentDigest ||
		int64(pkg.UnpackedSize) != skill.UnpackedSize || len(pkg.Files) == 0 {
		return repository.ErrInvariantConflict
	}
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var frozen []byte
	var owner, state string
	var until time.Time
	err = tx.QueryRowContext(ctx, `SELECT frozen_skills,lease_owner,state,lease_until FROM runtime_controller.skill_sets WHERE set_id=$1 FOR UPDATE`, setID).Scan(&frozen, &owner, &state, &until)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner != worker || state != "preparing" || !until.After(now) {
		return repository.ErrLockLost
	}
	var skills []skillset.FrozenSkill
	if err := json.Unmarshal(frozen, &skills); err != nil {
		return err
	}
	valid := false
	for _, candidate := range skills {
		if reflect.DeepEqual(candidate, skill) {
			valid = true
			break
		}
	}
	if !valid {
		return repository.ErrInvariantConflict
	}
	encoded, err := json.Marshal(struct {
		Files       []skillset.PackageFile `json:"files"`
		Directories []string               `json:"directories"`
	}{pkg.Files, pkg.Directories})
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.skill_package_checkpoints (set_id,skill_id,version,content_digest,verified_bytes,files)
VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (set_id,skill_id) DO NOTHING`, setID, skill.SkillID, skill.Version, skill.ContentDigest, skill.UnpackedSize, encoded)
	if err != nil {
		return err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if inserted == 1 {
		_, err = tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets SET verified_packages=verified_packages+1,verified_bytes=verified_bytes+$2,updated_at=$3 WHERE set_id=$1`, setID, skill.UnpackedSize, now)
		if err != nil {
			return err
		}
	} else {
		var version, verifiedBytes int64
		var digest string
		var previous []byte
		err = tx.QueryRowContext(ctx, `SELECT version,content_digest,verified_bytes,files FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1 AND skill_id=$2`, setID, skill.SkillID).Scan(&version, &digest, &verifiedBytes, &previous)
		if err != nil {
			return err
		}
		var stored struct {
			Files       []skillset.PackageFile `json:"files"`
			Directories []string               `json:"directories"`
		}
		if err := json.Unmarshal(previous, &stored); err != nil {
			return err
		}
		if version != skill.Version || digest != skill.ContentDigest || verifiedBytes != skill.UnpackedSize || !reflect.DeepEqual(stored.Files, pkg.Files) || !reflect.DeepEqual(stored.Directories, pkg.Directories) {
			return repository.ErrInvariantConflict
		}
	}
	return tx.Commit()
}

func (r *Repository) CompleteSkillPreparation(ctx context.Context, setID int64, worker, manifestDigest string, now time.Time) error {
	if !strings.HasPrefix(manifestDigest, "sha256:") || len(manifestDigest) != 71 {
		return repository.ErrInvariantConflict
	}
	result, err := r.database.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets
SET state='ready',manifest_digest=$4,lease_owner='',lease_until=NULL,updated_at=$3
WHERE set_id=$1 AND lease_owner=$2 AND state='preparing' AND lease_until>$3
  AND verified_packages=total_packages AND verified_bytes=total_bytes AND volume_name<>''`, setID, worker, now, manifestDigest)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return repository.ErrInvariantConflict
	}
	return nil
}

func (r *Repository) SetSkillPreparationFailure(ctx context.Context, setID int64, worker string, state skillset.PreparationState, errorCode string, retryAfter *time.Time, now time.Time) error {
	if state != skillset.PreparationRetryWait && state != skillset.PreparationPaused && state != skillset.PreparationRejected ||
		state == skillset.PreparationRetryWait && retryAfter == nil || errorCode == "" || len(errorCode) > 100 {
		return repository.ErrInvariantConflict
	}
	result, err := r.database.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets
SET state=$4,error_code=$5,retry_after=$6,lease_owner='',lease_until=NULL,updated_at=$3
WHERE set_id=$1 AND lease_owner=$2 AND state='preparing' AND lease_until>$3`, setID, worker, now, state, errorCode, retryAfter)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return repository.ErrLockLost
	}
	return nil
}

// ResetMissingSkillVolume abandons only a proven missing physical identity.
// The immutable logical set and its operation references survive; the next
// claim uses a new materialization and downloads a fresh candidate volume.
func (r *Repository) ResetMissingSkillVolume(ctx context.Context, setID int64, worker string, now time.Time) error {
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var owner, state string
	var until time.Time
	var materialization int64
	err = tx.QueryRowContext(ctx, `SELECT lease_owner,state,lease_until,materialization FROM runtime_controller.skill_sets WHERE set_id=$1 FOR UPDATE`, setID).Scan(&owner, &state, &until, &materialization)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner != worker || state != "preparing" || !until.After(now) {
		return repository.ErrLockLost
	}
	if materialization >= 1_000_000_000 {
		return repository.ErrInvariantConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1`, setID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets
SET state='queued',verified_packages=0,verified_bytes=0,materialization=materialization+1,
    volume_name='',manifest_digest='',lease_owner='',lease_until=NULL,retry_after=NULL,
    error_code='skill_volume_missing',updated_at=$2 WHERE set_id=$1`, setID, now)
	if err != nil {
		return err
	}
	return tx.Commit()
}
