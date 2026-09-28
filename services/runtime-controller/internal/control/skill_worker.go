package control

import (
	"context"
	"errors"
	"fmt"
	"time"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	"soft/antnest-platform/services/runtime-controller/internal/registryclient"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type SkillArtifactSource interface {
	Download(context.Context, string, skillset.FrozenSkill) ([]byte, skillset.Package, error)
}

type SkillVolumeStore interface {
	MaterializePackage(context.Context, skillset.SetKey, []byte, skillset.Package) error
	VerifyPackage(context.Context, skillset.SetKey, skillset.Package) error
	WriteManifest(context.Context, skillset.SetKey, []byte) error
}

type SkillPreparationWorker struct {
	store           repository.SkillPreparationWorkerStore
	source          SkillArtifactSource
	volumes         SkillVolumeStore
	scope, workerID string
}

func NewSkillPreparationWorker(store repository.SkillPreparationWorkerStore, source SkillArtifactSource, volumes SkillVolumeStore, scope, workerID string) (*SkillPreparationWorker, error) {
	if store == nil || source == nil || volumes == nil || scope == "" || workerID == "" {
		return nil, fmt.Errorf("skill preparation worker requires store, source, volumes and identity")
	}
	return &SkillPreparationWorker{store: store, source: source, volumes: volumes, scope: scope, workerID: workerID}, nil
}

// RunOnce processes at most one durable collection. The work budget is
// independent of the lifecycle mutation timeout; package checkpoints survive
// worker replacement and a later round rechecks their actual volume contents.
func (w *SkillPreparationWorker) RunOnce(ctx context.Context) (bool, error) {
	const lease = 6 * time.Minute
	job, err := w.store.ClaimSkillPreparation(ctx, w.scope, w.workerID, time.Now(), lease, 2)
	if err != nil || job == nil {
		return false, err
	}
	round, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if err := w.prepare(round, job, lease); err != nil {
		if errors.Is(err, platformdocker.ErrSkillVolumeMissing) {
			settle, done := context.WithTimeout(context.Background(), 10*time.Second)
			defer done()
			if resetErr := w.store.ResetMissingSkillVolume(settle, job.SetID, w.workerID, time.Now()); resetErr != nil {
				return true, errors.Join(err, resetErr)
			}
			return true, nil
		}
		state, code, retryAfter := classifySkillPreparationError(err)
		settle, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if failure := w.store.SetSkillPreparationFailure(settle, job.SetID, w.workerID, state, code, retryAfter, time.Now()); failure != nil {
			return true, errors.Join(err, failure)
		}
		return true, err
	}
	return true, nil
}

func (w *SkillPreparationWorker) prepare(ctx context.Context, job *skillset.PreparationJob, lease time.Duration) error {
	computed, err := skillset.Digest(job.Key.OrganizationID, job.Key.LayoutVersion, job.Skills)
	if err != nil || computed != job.Key.SkillSetDigest {
		return fmt.Errorf("%w: frozen Skill collection digest differs", registryclient.ErrArtifactMismatch)
	}
	name, err := job.Key.VolumeName()
	if err != nil || name != job.VolumeName && job.VolumeName != "" {
		return fmt.Errorf("%w: Skill volume identity differs", registryclient.ErrArtifactMismatch)
	}
	checkpoints := make(map[string]skillset.PackageCheckpoint, len(job.Checkpoints))
	for _, checkpoint := range job.Checkpoints {
		if _, exists := checkpoints[checkpoint.SkillID]; exists {
			return fmt.Errorf("%w: duplicate Skill checkpoint", repository.ErrInvariantConflict)
		}
		checkpoints[checkpoint.SkillID] = checkpoint
	}
	for _, skill := range job.Skills {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := w.store.RenewSkillPreparation(ctx, job.SetID, w.workerID, time.Now(), lease); err != nil {
			return err
		}
		if checkpoint, exists := checkpoints[skill.SkillID]; exists {
			pkg, err := skillset.PackageFromCheckpoint(skill, checkpoint)
			if err != nil {
				return fmt.Errorf("%w: %v", repository.ErrInvariantConflict, err)
			}
			if err := w.volumes.VerifyPackage(ctx, job.Key, pkg); err != nil {
				return fmt.Errorf("recheck Skill checkpoint: %w", err)
			}
			continue
		}
		artifact, pkg, err := w.source.Download(ctx, job.Key.OrganizationID, skill)
		if err != nil {
			return err
		}
		if err := w.volumes.MaterializePackage(ctx, job.Key, artifact, pkg); err != nil {
			return err
		}
		if err := w.store.CheckpointSkillPackage(ctx, job.SetID, w.workerID, skill, pkg, time.Now()); err != nil {
			return err
		}
		checkpoint := skillset.PackageCheckpoint{SkillID: skill.SkillID, Version: skill.Version,
			ContentDigest: skill.ContentDigest, VerifiedBytes: skill.UnpackedSize, Files: pkg.Files, Directories: pkg.Directories}
		job.Checkpoints = append(job.Checkpoints, checkpoint)
	}
	manifest, digest, err := skillset.CollectionManifest(*job)
	if err != nil {
		return err
	}
	if err := w.store.RenewSkillPreparation(ctx, job.SetID, w.workerID, time.Now(), lease); err != nil {
		return err
	}
	if err := w.volumes.WriteManifest(ctx, job.Key, manifest); err != nil {
		return err
	}
	return w.store.CompleteSkillPreparation(ctx, job.SetID, w.workerID, digest, time.Now())
}

func classifySkillPreparationError(err error) (skillset.PreparationState, string, *time.Time) {
	switch {
	case errors.Is(err, registryclient.ErrNotFound):
		return skillset.PreparationRejected, "skill_version_not_found", nil
	case errors.Is(err, registryclient.ErrArtifactMismatch):
		return skillset.PreparationRejected, "skill_artifact_mismatch", nil
	case errors.Is(err, registryclient.ErrUnauthorized):
		return skillset.PreparationPaused, "skill_registry_unauthorized", nil
	case errors.Is(err, repository.ErrInvariantConflict):
		return skillset.PreparationPaused, "skill_preparation_invariant", nil
	case errors.Is(err, repository.ErrLockLost):
		return skillset.PreparationPaused, "skill_preparation_lease_lost", nil
	case errors.Is(err, platformdocker.ErrNotFound):
		return skillset.PreparationPaused, "skill_volume_missing", nil
	case errors.Is(err, platformdocker.ErrConflict):
		return skillset.PreparationPaused, "skill_volume_drift", nil
	default:
		retry := time.Now().Add(15 * time.Second)
		return skillset.PreparationRetryWait, "skill_preparation_unavailable", &retry
	}
}
