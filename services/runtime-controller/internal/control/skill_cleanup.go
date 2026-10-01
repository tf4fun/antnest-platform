package control

import (
	"context"
	"errors"
	"fmt"
	"time"

	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

type SkillVolumeRemover interface {
	RemovePreparedVolume(context.Context, skillset.SetKey) error
}

type SkillCleanupWorker struct {
	store           repository.SkillCleanupStore
	volumes         SkillVolumeRemover
	scope, workerID string
}

func NewSkillCleanupWorker(store repository.SkillCleanupStore, volumes SkillVolumeRemover, scope, workerID string) (*SkillCleanupWorker, error) {
	if store == nil || volumes == nil || scope == "" || workerID == "" {
		return nil, fmt.Errorf("skill cleanup requires store, volume remover, and identity")
	}
	return &SkillCleanupWorker{store: store, volumes: volumes, scope: scope, workerID: workerID}, nil
}

// RunOnce deletes at most one unreferenced materialization. A lost Docker
// response is safe to retry: absence is idempotent, while in-use volumes are
// refused by Docker and keep their cleanup lease for a later round.
func (w *SkillCleanupWorker) RunOnce(ctx context.Context) (bool, error) {
	const lease = time.Minute
	job, err := w.store.ClaimSkillCleanup(ctx, w.scope, w.workerID, time.Now(), lease)
	if err != nil || job == nil {
		return false, err
	}
	round, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = w.volumes.RemovePreparedVolume(round, job.Key)
	cancel()
	settle, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	if err != nil {
		delay, code := 30*time.Second, "skill_cleanup_unavailable"
		if errors.Is(err, platformdocker.ErrConflict) {
			delay, code = 5*time.Minute, "skill_cleanup_in_use_or_drift"
		}
		if postponeErr := w.store.PostponeSkillCleanup(settle, job.SetID, w.workerID, time.Now(), delay, code); postponeErr != nil {
			return true, errors.Join(err, postponeErr)
		}
		return true, err
	}
	return true, w.store.CompleteSkillCleanup(settle, job.SetID, w.workerID, time.Now())
}
