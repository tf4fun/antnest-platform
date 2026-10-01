package control

import (
	"context"
	"errors"
	"testing"
	"time"

	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

type cleanupStoreStub struct {
	job       *skillset.CleanupJob
	completed int
	postponed int
}

func (s *cleanupStoreStub) ClaimSkillCleanup(context.Context, string, string, time.Time, time.Duration) (*skillset.CleanupJob, error) {
	return s.job, nil
}
func (s *cleanupStoreStub) CompleteSkillCleanup(context.Context, int64, string, time.Time) error {
	s.completed++
	return nil
}
func (s *cleanupStoreStub) PostponeSkillCleanup(context.Context, int64, string, time.Time, time.Duration, string) error {
	s.postponed++
	return nil
}

type cleanupVolumeStub struct {
	err   error
	calls int
}

func (v *cleanupVolumeStub) RemovePreparedVolume(context.Context, skillset.SetKey) error {
	v.calls++
	return v.err
}

func TestSkillCleanupWorkerSettlesOnlyAfterOwnedVolumeRemoval(t *testing.T) {
	for _, broken := range []bool{false, true} {
		store := &cleanupStoreStub{job: &skillset.CleanupJob{SetID: 7, Key: skillset.SetKey{Scope: "test", Materialization: 1}, VolumeName: "test"}}
		volume := &cleanupVolumeStub{}
		if broken {
			volume.err = platformdocker.ErrConflict
		}
		worker, err := NewSkillCleanupWorker(store, volume, "test", "worker")
		if err != nil {
			t.Fatal(err)
		}
		worked, err := worker.RunOnce(context.Background())
		if !worked || volume.calls != 1 {
			t.Fatalf("cleanup not attempted: worked=%v calls=%d err=%v", worked, volume.calls, err)
		}
		if broken && (!errors.Is(err, platformdocker.ErrConflict) || store.completed != 0 || store.postponed != 1) {
			t.Fatalf("unsafe cleanup settled: completed=%d postponed=%d err=%v", store.completed, store.postponed, err)
		}
		if !broken && (err != nil || store.completed != 1 || store.postponed != 0) {
			t.Fatalf("removed volume not settled: completed=%d postponed=%d err=%v", store.completed, store.postponed, err)
		}
	}
}
