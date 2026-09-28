package control

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	"soft/antnest-platform/services/runtime-controller/internal/registryclient"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type workerStoreStub struct {
	job                            *skillset.PreparationJob
	checkpointed, completed, reset bool
	state                          skillset.PreparationState
}

func (s *workerStoreStub) ClaimSkillPreparation(context.Context, string, string, time.Time, time.Duration, int) (*skillset.PreparationJob, error) {
	return s.job, nil
}
func (s *workerStoreStub) RenewSkillPreparation(context.Context, int64, string, time.Time, time.Duration) error {
	return nil
}
func (s *workerStoreStub) CheckpointSkillPackage(_ context.Context, _ int64, _ string, skill skillset.FrozenSkill, pkg skillset.Package, _ time.Time) error {
	s.checkpointed = true
	return nil
}
func (s *workerStoreStub) CompleteSkillPreparation(context.Context, int64, string, string, time.Time) error {
	s.completed = true
	return nil
}
func (s *workerStoreStub) SetSkillPreparationFailure(_ context.Context, _ int64, _ string, state skillset.PreparationState, _ string, _ *time.Time, _ time.Time) error {
	s.state = state
	return nil
}
func (s *workerStoreStub) ResetMissingSkillVolume(context.Context, int64, string, time.Time) error {
	s.reset = true
	return nil
}

type workerDownloadStub struct {
	calls    int
	artifact []byte
	pkg      skillset.Package
	err      error
}

func (d *workerDownloadStub) Download(context.Context, string, skillset.FrozenSkill) ([]byte, skillset.Package, error) {
	d.calls++
	return d.artifact, d.pkg, d.err
}

type workerVolumeStub struct {
	materialized, verified, manifest bool
	err                              error
}

func (v *workerVolumeStub) MaterializePackage(context.Context, skillset.SetKey, []byte, skillset.Package) error {
	v.materialized = true
	return v.err
}
func (v *workerVolumeStub) VerifyPackage(context.Context, skillset.SetKey, skillset.Package) error {
	v.verified = true
	return v.err
}
func (v *workerVolumeStub) WriteManifest(context.Context, skillset.SetKey, []byte) error {
	v.manifest = true
	return v.err
}

func TestSkillWorkerCompletesAndResumesVerifiedPackage(t *testing.T) {
	var archive bytes.Buffer
	zipWriter := zip.NewWriter(&archive)
	member, err := zipWriter.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(member, "---\nname: code-review\ndescription: Review code\n---\n"); err != nil {
		t.Fatal(err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	pkg, err := skillset.InspectArtifact(context.Background(), archive.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	skill := skillset.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: pkg.Name, Description: pkg.Description, ArtifactDigest: pkg.ArtifactDigest, ContentDigest: pkg.ContentDigest, ArtifactSize: int64(archive.Len()), UnpackedSize: int64(pkg.UnpackedSize), PackageRulesVersion: 1}
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, []skillset.FrozenSkill{skill})
	if err != nil {
		t.Fatal(err)
	}
	job := &skillset.PreparationJob{SetID: 1, Key: skillset.SetKey{Scope: "test", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}, Skills: []skillset.FrozenSkill{skill}}
	store := &workerStoreStub{job: job}
	download := &workerDownloadStub{artifact: archive.Bytes(), pkg: pkg}
	volume := &workerVolumeStub{}
	worker, err := NewSkillPreparationWorker(store, download, volume, "test", "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := worker.RunOnce(context.Background()); err != nil || !worked || !store.checkpointed || !store.completed || !volume.materialized || !volume.manifest {
		t.Fatalf("fresh preparation: worked=%v err=%v store=%+v volume=%+v", worked, err, store, volume)
	}
	store.checkpointed, store.completed = false, false
	volume.materialized, volume.manifest, volume.verified = false, false, false
	download.calls = 0
	if worked, err := worker.RunOnce(context.Background()); err != nil || !worked || !store.completed || !volume.verified || volume.materialized || download.calls != 0 {
		t.Fatalf("resumed preparation: worked=%v err=%v store=%+v volume=%+v downloads=%d", worked, err, store, volume, download.calls)
	}
	store.completed = false
	volume.err = platformdocker.ErrSkillVolumeMissing
	if worked, err := worker.RunOnce(context.Background()); err != nil || !worked || !store.reset || store.completed {
		t.Fatalf("missing volume reset: worked=%v err=%v store=%+v", worked, err, store)
	}
}

func TestSkillWorkerClassifiesRegistryFailure(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want skillset.PreparationState
	}{{registryclient.ErrNotFound, skillset.PreparationRejected}, {registryclient.ErrUnauthorized, skillset.PreparationPaused}, {registryclient.ErrUnavailable, skillset.PreparationRetryWait}} {
		skill := skillset.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64), ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}
		org := "org_00000000000000000000000000000000"
		digest, err := skillset.Digest(org, 1, []skillset.FrozenSkill{skill})
		if err != nil {
			t.Fatal(err)
		}
		store := &workerStoreStub{job: &skillset.PreparationJob{SetID: 1, Key: skillset.SetKey{Scope: "test", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}, Skills: []skillset.FrozenSkill{skill}}}
		worker, err := NewSkillPreparationWorker(store, &workerDownloadStub{err: tc.err}, &workerVolumeStub{}, "test", "worker-1")
		if err != nil {
			t.Fatal(err)
		}
		_, runErr := worker.RunOnce(context.Background())
		if !errors.Is(runErr, tc.err) || store.state != tc.want {
			t.Fatalf("err=%v state=%s want=%s", runErr, store.state, tc.want)
		}
	}
}

func TestSkillWorkerPreparesEmptyCollectionWithoutRegistry(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &workerStoreStub{job: &skillset.PreparationJob{SetID: 1, Key: skillset.SetKey{Scope: "test", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}}}
	download := &workerDownloadStub{err: errors.New("Registry must not be called")}
	volume := &workerVolumeStub{}
	worker, err := NewSkillPreparationWorker(store, download, volume, "test", "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	worked, err := worker.RunOnce(context.Background())
	if err != nil || !worked || !store.completed || !volume.manifest || download.calls != 0 {
		t.Fatalf("empty set: worked=%v err=%v completed=%v manifest=%v downloads=%d", worked, err, store.completed, volume.manifest, download.calls)
	}
}
