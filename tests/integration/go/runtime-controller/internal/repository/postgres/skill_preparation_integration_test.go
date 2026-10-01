package postgres

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestSkillPreparationIsDurableIdempotentAndScoped(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	organization := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(organization, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	first := skillset.PrepareRequest{
		Scope: "test-scope", RequestID: "prepare-1", AgentID: "agent-1",
		OrganizationID: organization, OwnerOperationID: "build-1",
		LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest,
		SystemSkills: []skillset.FrozenSkill{},
	}
	receipt, err := repository.AdmitSkillPreparation(ctx, first)
	if err != nil || receipt.State != skillset.PreparationQueued || receipt.Progress.TotalPackages != 0 || receipt.PreparedReferenceID != "" {
		t.Fatalf("admit: %+v %v", receipt, err)
	}
	replayed, err := repository.AdmitSkillPreparation(ctx, first)
	if err != nil || replayed != receipt {
		t.Fatalf("replay: %+v %v", replayed, err)
	}
	changed := first
	changed.OwnerOperationID = "other-build"
	if _, err := repository.AdmitSkillPreparation(ctx, changed); !errors.Is(err, repositoryport.ErrIdempotencyConflict) {
		t.Fatalf("changed replay = %v", err)
	}
	second := first
	second.RequestID, second.OwnerOperationID = "prepare-2", "build-2"
	if _, err := repository.AdmitSkillPreparation(ctx, second); err != nil {
		t.Fatal(err)
	}
	var sets, references int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_sets`).Scan(&sets); err != nil || sets != 1 {
		t.Fatalf("same collection not merged: %d %v", sets, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_preparations`).Scan(&references); err != nil || references != 2 {
		t.Fatalf("operation references not independent: %d %v", references, err)
	}
	for _, wrong := range []struct{ organization, agent, request string }{
		{"org_22222222222222222222222222222222", "agent-1", "prepare-1"},
		{organization, "agent-2", "prepare-1"},
		{organization, "agent-1", "missing"},
	} {
		if _, err := repository.GetSkillPreparation(ctx, first.Scope, wrong.organization, wrong.agent, wrong.request); !errors.Is(err, repositoryport.ErrNotFound) {
			t.Fatalf("cross-scope lookup = %v", err)
		}
	}
	stored, err := repository.GetSkillPreparation(ctx, first.Scope, organization, "agent-1", first.RequestID)
	if err != nil || stored != receipt {
		t.Fatalf("durable read: %+v %v", stored, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET state='ready', volume_name='skill-check', manifest_digest=$1`, digest); err != nil {
		t.Fatal(err)
	}
	firstReady, err := repository.GetSkillPreparation(ctx, first.Scope, organization, "agent-1", first.RequestID)
	if err != nil || firstReady.State != skillset.PreparationReady || firstReady.PreparedReferenceID == "" || firstReady.PreparedSkillSet == nil {
		t.Fatalf("ready first reference: %+v %v", firstReady, err)
	}
	secondReady, err := repository.GetSkillPreparation(ctx, second.Scope, organization, "agent-1", second.RequestID)
	if err != nil || secondReady.PreparedReferenceID == "" || secondReady.PreparedReferenceID == firstReady.PreparedReferenceID {
		t.Fatalf("ready second reference: %+v %v", secondReady, err)
	}
	if err := repository.ReleaseSkillPreparation(ctx, first.Scope, organization, "agent-1", first.RequestID, "build-1"); err != nil {
		t.Fatal(err)
	}
	if err := repository.ReleaseSkillPreparation(ctx, first.Scope, organization, "agent-1", first.RequestID, "build-1"); err != nil {
		t.Fatalf("release replay: %v", err)
	}
	released, err := repository.GetSkillPreparation(ctx, first.Scope, organization, "agent-1", first.RequestID)
	if err != nil || released.PreparedReferenceID != "" {
		t.Fatalf("released reference remains usable: %+v %v", released, err)
	}
	stillReady, err := repository.GetSkillPreparation(ctx, second.Scope, organization, "agent-1", second.RequestID)
	if err != nil || stillReady.PreparedReferenceID != secondReady.PreparedReferenceID {
		t.Fatalf("other owner's reference changed: %+v %v", stillReady, err)
	}
	if err := repository.ReleaseSkillPreparation(ctx, first.Scope, organization, "agent-1", second.RequestID, "build-1"); !errors.Is(err, repositoryport.ErrNotFound) {
		t.Fatalf("another operation released reference: %v", err)
	}
}

func TestMissingReadySkillVolumeRequeuesOnlyWithoutActiveRuntime(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "test-scope", RequestID: "prepare-1", AgentID: "agent-1", OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := repository.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	job, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-1", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	manifest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := repository.CompleteSkillPreparation(ctx, job.SetID, "worker-1", manifest, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := repository.GetSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	reference := skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills}
	prepared, err := repository.ResolvePreparedSkillSet(ctx, reference)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.runtime_environments(agent_id,runtime_revision,lifecycle_state,generation,spec_digest,updated_at) VALUES ($1,$2,'provisioned',1,$3,NOW())`, request.AgentID, "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", digest); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.skill_current_references(agent_id,set_id,materialization,volume_name,manifest_digest) VALUES ($1,$2,$3,$4,$5)`, request.AgentID, prepared.SetID, prepared.Key.Materialization, prepared.VolumeName, prepared.ManifestDigest); err != nil {
		t.Fatal(err)
	}
	if err := repository.ResetMissingReadySkillVolume(ctx, prepared); !errors.Is(err, repositoryport.ErrConcurrentMutation) {
		t.Fatalf("active Runtime reset = %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE runtime_controller.runtime_environments SET lifecycle_state='disabled' WHERE agent_id=$1`, request.AgentID); err != nil {
		t.Fatal(err)
	}
	if err := repository.ResetMissingReadySkillVolume(ctx, prepared); err != nil {
		t.Fatal(err)
	}
	after, err := repository.GetSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID)
	if err != nil || after.State != skillset.PreparationQueued || after.PreparedReferenceID != "" || after.Progress.VerifiedPackages != 0 {
		t.Fatalf("requeue: %+v %v", after, err)
	}
	if _, err := repository.ResolvePreparedSkillSet(ctx, reference); !errors.Is(err, repositoryport.ErrPreparedSkillSetInvalidated) {
		t.Fatalf("stale ready reference = %v", err)
	}
	replacement, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-2", now.Add(2*time.Second), time.Minute, 1)
	if err != nil || replacement == nil || replacement.Key.Materialization != prepared.Key.Materialization+1 || replacement.VolumeName == prepared.VolumeName {
		t.Fatalf("replacement: %+v %v", replacement, err)
	}
}

func TestMissingReadyTargetVolumeRequeuesWhileSourceRuntimeActive(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	organization := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(organization, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "test-scope", RequestID: "prepare-target", AgentID: "agent-1", OrganizationID: organization,
		OwnerOperationID: "rebuild-target", LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest}
	if _, err := repository.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	job, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-1", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim target: %+v %v", job, err)
	}
	manifest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := repository.CompleteSkillPreparation(ctx, job.SetID, "worker-1", manifest, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := repository.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := repository.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{Scope: request.Scope, OrganizationID: organization,
		AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion,
		ReferenceID: receipt.PreparedReferenceID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.runtime_environments(agent_id,runtime_revision,lifecycle_state,generation,spec_digest,updated_at) VALUES ($1,$2,'provisioned',1,$3,NOW())`, request.AgentID, "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", digest); err != nil {
		t.Fatal(err)
	}
	var sourceSetID int64
	if err := database.QueryRowContext(ctx, `INSERT INTO runtime_controller.skill_sets(controller_scope,organization_id,agent_id,skill_set_digest,layout_version,frozen_skills,state,total_packages,total_bytes,materialization,volume_name,manifest_digest) VALUES ($1,$2,$3,$4,1,'[]','ready',0,0,1,'source-volume',$5) RETURNING set_id`, request.Scope, organization, request.AgentID,
		"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", manifest).Scan(&sourceSetID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.skill_current_references(agent_id,set_id,materialization,volume_name,manifest_digest) VALUES ($1,$2,1,'source-volume',$3)`, request.AgentID, sourceSetID, manifest); err != nil {
		t.Fatal(err)
	}
	if err := repository.ResetMissingReadySkillVolume(ctx, prepared); err != nil {
		t.Fatalf("inactive target reset while source runs: %v", err)
	}
	after, err := repository.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
	if err != nil || after.State != skillset.PreparationQueued || after.PreparedReferenceID != "" {
		t.Fatalf("target did not requeue: %+v %v", after, err)
	}
	var currentSetID int64
	if err := database.QueryRowContext(ctx, `SELECT set_id FROM runtime_controller.skill_current_references WHERE agent_id=$1`, request.AgentID).Scan(&currentSetID); err != nil || currentSetID != sourceSetID {
		t.Fatalf("source current reference changed: %d %v", currentSetID, err)
	}
}

func TestSkillPreparationLeaseAndPackageCheckpointSurviveWorkerReplacement(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	organization := "org_00000000000000000000000000000000"
	frozen := skillset.FrozenSkill{
		SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: "code-review", Description: "Review code",
		ArtifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ContentDigest:  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ArtifactSize:   100, UnpackedSize: 200, PackageRulesVersion: 1,
	}
	digest, err := skillset.Digest(organization, 1, []skillset.FrozenSkill{frozen})
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "test-scope", RequestID: "prepare-1", AgentID: "agent-1",
		OrganizationID: organization, OwnerOperationID: "build-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{frozen}}
	if _, err := repository.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	first, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-a", now, time.Minute, 1)
	if err != nil || first == nil || first.VolumeName == "" || first.Key.Materialization != 1 || len(first.Skills) != 1 {
		t.Fatalf("first lease: %+v %v", first, err)
	}
	busy, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-b", now.Add(time.Second), time.Minute, 1)
	if err != nil || busy != nil {
		t.Fatalf("concurrent capacity exceeded: %+v %v", busy, err)
	}
	pkg := skillset.Package{Name: frozen.Name, Description: frozen.Description, ContentDigest: frozen.ContentDigest, UnpackedSize: uint64(frozen.UnpackedSize),
		Files: []skillset.PackageFile{{Path: "SKILL.md", Size: 200, Digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}}
	if err := repository.CheckpointSkillPackage(ctx, first.SetID, "worker-b", frozen, pkg, now.Add(time.Second)); !errors.Is(err, repositoryport.ErrLockLost) {
		t.Fatalf("wrong worker checkpoint: %v", err)
	}
	if err := repository.CheckpointSkillPackage(ctx, first.SetID, "worker-a", frozen, pkg, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	resumed, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-b", now.Add(2*time.Minute), time.Minute, 1)
	if err != nil || resumed == nil || resumed.VolumeName != first.VolumeName || len(resumed.Checkpoints) != 1 || resumed.Checkpoints[0].SkillID != frozen.SkillID {
		t.Fatalf("replacement did not retain progress: %+v %v", resumed, err)
	}
	if err := repository.CheckpointSkillPackage(ctx, resumed.SetID, "worker-b", frozen, pkg, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("same verified checkpoint replay: %v", err)
	}
	if err := repository.ResetMissingSkillVolume(ctx, resumed.SetID, "worker-b", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("reset missing physical volume: %v", err)
	}
	replacement, err := repository.ClaimSkillPreparation(ctx, request.Scope, "worker-c", now.Add(2*time.Minute+time.Second), time.Minute, 1)
	if err != nil || replacement == nil || replacement.Key.Materialization != 2 || replacement.VolumeName == resumed.VolumeName || len(replacement.Checkpoints) != 0 {
		t.Fatalf("replacement materialization: %+v %v", replacement, err)
	}
	if err := repository.CheckpointSkillPackage(ctx, replacement.SetID, "worker-c", frozen, pkg, now.Add(2*time.Minute+2*time.Second)); err != nil {
		t.Fatal(err)
	}
	manifestDigest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := repository.CompleteSkillPreparation(ctx, replacement.SetID, "worker-c", manifestDigest, now.Add(2*time.Minute+2*time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := repository.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
	if err != nil || receipt.State != skillset.PreparationReady || receipt.Progress.VerifiedPackages != 1 || receipt.Progress.VerifiedBytes != 200 || receipt.PreparedReferenceID == "" {
		t.Fatalf("completed progress: %+v %v", receipt, err)
	}
}

func TestReadySkillReferenceResolvesOnlyExactActiveMaterialization(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "reference-scope", RequestID: "reference-prepare-1", AgentID: "agent-reference-1", OrganizationID: org, OwnerOperationID: "build-reference-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := repository.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	job, err := repository.ClaimSkillPreparation(ctx, request.Scope, "reference-worker", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	manifestDigest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := repository.CompleteSkillPreparation(ctx, job.SetID, "reference-worker", manifestDigest, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// A normal Drain may last five minutes. The operation-owned reference must
	// survive that interval and a fresh RC repository instance before acceptance.
	if _, err := repository.database.ExecContext(ctx, `UPDATE runtime_controller.skill_preparations SET created_at=NOW()-INTERVAL '6 minutes',updated_at=NOW()-INTERVAL '6 minutes' WHERE request_id=$1`, request.RequestID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.database.ExecContext(ctx, `UPDATE runtime_controller.skill_sets SET created_at=NOW()-INTERVAL '6 minutes',updated_at=NOW()-INTERVAL '6 minutes' WHERE set_id=$1`, job.SetID); err != nil {
		t.Fatal(err)
	}
	databaseURL := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL")
	restartedDatabase, err := OpenDatabase(ctx, databaseURL, 20, 5)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restartedDatabase.Close() })
	restartedLockDatabase, err := OpenDatabase(ctx, databaseURL, 8, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restartedLockDatabase.Close() })
	restartedRepository, err := New(restartedDatabase, restartedLockDatabase, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := restartedRepository.GetSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := restartedRepository.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills})
	if err != nil || got.VolumeName != job.VolumeName || got.ManifestDigest != manifestDigest || got.Key.Materialization != 1 {
		t.Fatalf("ready reference: %+v %v", got, err)
	}
	operation := integrationOperation("reference-init", deployment.OperationInitializeRuntime, now.Add(2*time.Second))
	operation.AgentID = request.AgentID
	operation.RuntimeRevision = deployment.RevisionFor(operation.RequestID, operation.RequestDigest)
	operation.ImageReference = "antnest/runtime:latest"
	operation.ImageID = integrationSpecDigest
	operation.Transition = deployment.LifecycleInitializing
	operation.PreparedReference = &skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills}
	invalid := operation
	invalid.RequestID = "reference-invalid-before-begin"
	invalid.PreparedReference = &skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: "psr_00000000000000000000000000000000", SystemSkills: request.SystemSkills}
	if _, _, err := restartedRepository.BeginTransition(ctx, invalid); !errors.Is(err, repositoryport.ErrPreparedSkillSetInvalidated) {
		t.Fatalf("invalid reference created lifecycle: %v", err)
	}
	if _, err := restartedRepository.GetOperation(ctx, invalid.RequestID); !errors.Is(err, repositoryport.ErrNotFound) {
		t.Fatalf("invalid reference left operation receipt: %v", err)
	}
	started, replay, err := restartedRepository.BeginTransition(ctx, operation)
	if err != nil || replay || started.PreparedSetID != job.SetID || started.PreparedVolumeName != job.VolumeName || started.PreparedManifestDigest != manifestDigest {
		t.Fatalf("atomic lifecycle reference: %+v replay=%v err=%v", started, replay, err)
	}
	var retained int
	if err := restartedRepository.database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_lifecycle_references WHERE operation_request_id=$1`, operation.RequestID).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("lifecycle reference count=%d err=%v", retained, err)
	}
	if err := restartedRepository.ReleaseSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID, request.OwnerOperationID); err != nil {
		t.Fatal(err)
	}
	replayed, replay, err := restartedRepository.BeginTransition(ctx, operation)
	if err != nil || !replay || replayed.PreparedSetID != job.SetID || replayed.PreparedVolumeName != job.VolumeName {
		t.Fatalf("released preparation changed accepted replay: %+v replay=%v err=%v", replayed, replay, err)
	}
	_, err = restartedRepository.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills})
	if !errors.Is(err, repositoryport.ErrPreparedSkillSetInvalidated) {
		t.Fatalf("released reference accepted: %v", err)
	}
}
