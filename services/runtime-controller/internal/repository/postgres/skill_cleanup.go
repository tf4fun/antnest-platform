package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

var _ repository.SkillCleanupStore = (*Repository)(nil)

func (r *Repository) ClaimSkillCleanup(ctx context.Context, scope, worker string, now time.Time, lease time.Duration) (*skillset.CleanupJob, error) {
	if scope == "" || worker == "" || lease <= 0 {
		return nil, fmt.Errorf("invalid Skill cleanup claim")
	}
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var job skillset.CleanupJob
	err = tx.QueryRowContext(ctx, `
SELECT s.set_id,s.controller_scope,s.organization_id,s.agent_id,s.skill_set_digest,s.layout_version,s.materialization,s.volume_name
FROM runtime_controller.skill_sets s
WHERE s.controller_scope=$1 AND s.volume_name<>''
	  AND (s.state IN ('ready','invalidated') OR s.state='cleanup_pending' AND s.lease_until<=$2)
  AND (
    (NOT EXISTS (SELECT 1 FROM runtime_controller.skill_preparations p WHERE p.set_id=s.set_id AND NOT p.released)
      AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_lifecycle_references l WHERE l.set_id=s.set_id)
      AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_current_references c WHERE c.set_id=s.set_id))
    OR
    (s.state='cleanup_pending' AND s.error_code LIKE 'skill_volume_drift%'
      AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_lifecycle_references l WHERE l.set_id=s.set_id)
      AND NOT EXISTS (SELECT 1 FROM runtime_controller.operations o WHERE o.agent_id=s.agent_id AND o.state IN ('running','unknown'))
      AND (NOT EXISTS (SELECT 1 FROM runtime_controller.skill_current_references c WHERE c.set_id=s.set_id)
        OR NOT EXISTS (SELECT 1 FROM runtime_controller.runtime_environments e WHERE e.agent_id=s.agent_id AND e.lifecycle_state NOT IN ('disabled','deleted'))))
  )
ORDER BY s.updated_at,s.set_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, scope, now).Scan(
		&job.SetID, &job.Key.Scope, &job.Key.OrganizationID, &job.Key.AgentID, &job.Key.SkillSetDigest, &job.Key.LayoutVersion, &job.Key.Materialization, &job.VolumeName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select Skill cleanup candidate: %w", err)
	}
	name, err := job.Key.VolumeName()
	if err != nil || name != job.VolumeName {
		return nil, repository.ErrInvariantConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='cleanup_pending',lease_owner=$2,lease_until=$3,error_code=CASE WHEN error_code LIKE 'skill_volume_drift%' THEN error_code ELSE '' END,updated_at=$4 WHERE set_id=$1`, job.SetID, worker, now.Add(lease), now); err != nil {
		return nil, fmt.Errorf("claim Skill cleanup: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit Skill cleanup claim: %w", err)
	}
	return &job, nil
}

func (r *Repository) CompleteSkillCleanup(ctx context.Context, setID int64, worker string, now time.Time) error {
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var agentID string
	if err := tx.QueryRowContext(ctx, `SELECT agent_id FROM runtime_controller.skill_sets WHERE set_id=$1`, setID).Scan(&agentID); err != nil {
		return err
	}
	var lifecycle string
	envErr := tx.QueryRowContext(ctx, `SELECT lifecycle_state FROM runtime_controller.runtime_environments WHERE agent_id=$1 FOR UPDATE`, agentID).Scan(&lifecycle)
	if envErr != nil && !errors.Is(envErr, sql.ErrNoRows) {
		return envErr
	}
	var state, owner, code string
	var leaseUntil sql.NullTime
	var materialization int64
	if err := tx.QueryRowContext(ctx, `SELECT state,lease_owner,lease_until,error_code,materialization FROM runtime_controller.skill_sets WHERE set_id=$1 FOR UPDATE`, setID).Scan(&state, &owner, &leaseUntil, &code, &materialization); err != nil {
		return err
	}
	if state == string(skillset.PreparationCleanupPending) && len(code) >= len("skill_volume_drift") && code[:len("skill_volume_drift")] == "skill_volume_drift" {
		if owner != worker || !leaseUntil.Valid || !leaseUntil.Time.After(now) || materialization >= 1_000_000_000 {
			return repository.ErrLockLost
		}
		var inFlight, lifecycleReference, current bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runtime_controller.operations WHERE agent_id=$1 AND state IN ('running','unknown')),EXISTS(SELECT 1 FROM runtime_controller.skill_lifecycle_references WHERE set_id=$2),EXISTS(SELECT 1 FROM runtime_controller.skill_current_references WHERE agent_id=$1 AND set_id=$2)`, agentID, setID).Scan(&inFlight, &lifecycleReference, &current); err != nil {
			return err
		}
		if inFlight || lifecycleReference || current && envErr == nil && lifecycle != "disabled" && lifecycle != "deleted" {
			return repository.ErrConcurrentMutation
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_current_references WHERE agent_id=$1 AND set_id=$2 AND materialization=$3`, agentID, setID, materialization); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='queued',materialization=materialization+1,volume_name='',manifest_digest='',verified_packages=0,verified_bytes=0,lease_owner='',lease_until=NULL,retry_after=NULL,error_code='skill_volume_drift_requeued',updated_at=$3 WHERE set_id=$1 AND lease_owner=$2 AND state='cleanup_pending'`, setID, worker, now)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return repository.ErrLockLost
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1`, setID); err != nil {
			return err
		}
		return tx.Commit()
	}
	result, err := tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets SET state='invalidated',materialization=materialization+1,
  volume_name='',manifest_digest='',verified_packages=0,verified_bytes=0,
  lease_owner='',lease_until=NULL,retry_after=NULL,error_code='',updated_at=$3
WHERE set_id=$1 AND lease_owner=$2 AND state='cleanup_pending' AND lease_until>$3 AND materialization<1000000000
  AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_preparations p WHERE p.set_id=$1 AND NOT p.released)
  AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_lifecycle_references l WHERE l.set_id=$1)
  AND NOT EXISTS (SELECT 1 FROM runtime_controller.skill_current_references c WHERE c.set_id=$1)`, setID, worker, now)
	if err != nil {
		return fmt.Errorf("complete Skill cleanup: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return repository.ErrLockLost
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_package_checkpoints WHERE set_id=$1`, setID); err != nil {
		return fmt.Errorf("clear collected Skill checkpoints: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Skill cleanup: %w", err)
	}
	return nil
}

func (r *Repository) PostponeSkillCleanup(ctx context.Context, setID int64, worker string, now time.Time, delay time.Duration, code string) error {
	if delay <= 0 || code == "" {
		return fmt.Errorf("invalid Skill cleanup retry")
	}
	result, err := r.database.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET lease_until=$4,error_code=CASE WHEN error_code LIKE 'skill_volume_drift%' THEN 'skill_volume_drift:' || $5 ELSE $5 END,updated_at=$3 WHERE set_id=$1 AND lease_owner=$2 AND state='cleanup_pending' AND lease_until>$3`, setID, worker, now, now.Add(delay), code)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return repository.ErrLockLost
	}
	return nil
}
