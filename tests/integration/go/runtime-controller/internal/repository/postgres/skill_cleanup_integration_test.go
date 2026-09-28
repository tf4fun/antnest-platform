package postgres

import (
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestSkillCleanupRequiresReleasedReferencesAndRematerializesAfterRemoval(t *testing.T) {
	store, _, ctx := integrationRepository(t)
	now := time.Now().UTC()
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "cleanup-scope", RequestID: "cleanup-original", AgentID: "agent-cleanup", OrganizationID: org, OwnerOperationID: "owner-original", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	prepared, err := store.ClaimSkillPreparation(ctx, request.Scope, "preparer", now, time.Minute, 1)
	if err != nil || prepared == nil {
		t.Fatalf("claim preparation: %+v %v", prepared, err)
	}
	if err := store.CompleteSkillPreparation(ctx, prepared.SetID, "preparer", "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	candidate, err := store.ClaimSkillCleanup(ctx, request.Scope, "cleaner", now.Add(2*time.Second), time.Minute)
	if err != nil || candidate != nil {
		t.Fatalf("active preparation reference was collectible: %+v %v", candidate, err)
	}
	if err := store.ReleaseSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID, request.OwnerOperationID); err != nil {
		t.Fatal(err)
	}
	candidate, err = store.ClaimSkillCleanup(ctx, request.Scope, "cleaner", now.Add(2*time.Second), time.Minute)
	if err != nil || candidate == nil || candidate.SetID != prepared.SetID || candidate.VolumeName != prepared.VolumeName {
		t.Fatalf("unreferenced set not claimed: %+v %v", candidate, err)
	}
	newer := request
	newer.RequestID = "cleanup-new"
	newer.OwnerOperationID = "owner-new"
	if _, err := store.AdmitSkillPreparation(ctx, newer); !errors.Is(err, repository.ErrSkillCleanupInProgress) {
		t.Fatalf("new reference raced deletion: %v", err)
	}
	if err := store.CompleteSkillCleanup(ctx, candidate.SetID, "cleaner", now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := store.AdmitSkillPreparation(ctx, newer)
	if err != nil || receipt.State != skillset.PreparationQueued {
		t.Fatalf("requeue after cleanup: %+v %v", receipt, err)
	}
	replacement, err := store.ClaimSkillPreparation(ctx, request.Scope, "preparer-2", now.Add(4*time.Second), time.Minute, 1)
	if err != nil || replacement == nil || replacement.SetID != candidate.SetID || replacement.Key.Materialization != candidate.Key.Materialization+1 || replacement.VolumeName == candidate.VolumeName {
		t.Fatalf("replacement identity: %+v %v", replacement, err)
	}
}

func TestReadyContentDriftCleanupRetainsIntentButReplacesDisabledCurrentVolume(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	now := time.Now().UTC()
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "drift-scope", RequestID: "drift-prepare", AgentID: "agent-drift", OrganizationID: org, OwnerOperationID: "drift-owner", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	job, err := store.ClaimSkillPreparation(ctx, request.Scope, "preparer", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim: %+v %v", job, err)
	}
	manifest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := store.CompleteSkillPreparation(ctx, job.SetID, "preparer", manifest, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := store.GetSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	reference := skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: request.AgentID, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills}
	prepared, err := store.ResolvePreparedSkillSet(ctx, reference)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.runtime_environments(agent_id,runtime_revision,lifecycle_state,generation,spec_digest,updated_at) VALUES ($1,$2,'provisioned',1,$3,NOW())`, request.AgentID, "rtv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", digest); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.skill_current_references(agent_id,set_id,materialization,volume_name,manifest_digest) VALUES ($1,$2,$3,$4,$5)`, request.AgentID, prepared.SetID, prepared.Key.Materialization, prepared.VolumeName, prepared.ManifestDigest); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkDriftedReadySkillVolume(ctx, prepared); !errors.Is(err, repository.ErrConcurrentMutation) {
		t.Fatalf("active Runtime drift cleanup = %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE runtime_controller.runtime_environments SET lifecycle_state='disabled' WHERE agent_id=$1`, request.AgentID); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkDriftedReadySkillVolume(ctx, prepared); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolvePreparedSkillSet(ctx, reference); !errors.Is(err, repository.ErrPreparedSkillSetInvalidated) {
		t.Fatalf("drifted set remained consumable: %v", err)
	}
	cleanup, err := store.ClaimSkillCleanup(ctx, request.Scope, "cleaner", now.Add(2*time.Second), time.Minute)
	if err != nil || cleanup == nil || cleanup.VolumeName != prepared.VolumeName {
		t.Fatalf("drifted retained set not claimed: %+v %v", cleanup, err)
	}
	if err := store.PostponeSkillCleanup(ctx, cleanup.SetID, "cleaner", now.Add(3*time.Second), time.Second, "skill_cleanup_unavailable"); err != nil {
		t.Fatal(err)
	}
	cleanup, err = store.ClaimSkillCleanup(ctx, request.Scope, "cleaner-2", now.Add(5*time.Second), time.Minute)
	if err != nil || cleanup == nil {
		t.Fatalf("drift cleanup marker lost on retry: %+v %v", cleanup, err)
	}
	if err := store.CompleteSkillCleanup(ctx, cleanup.SetID, "cleaner-2", now.Add(6*time.Second)); err != nil {
		t.Fatal(err)
	}
	back, err := store.GetSkillPreparation(ctx, request.Scope, org, request.AgentID, request.RequestID)
	if err != nil || back.State != skillset.PreparationQueued || back.PreparedReferenceID != "" {
		t.Fatalf("original intent did not requeue: %+v %v", back, err)
	}
	var current int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_current_references WHERE agent_id=$1`, request.AgentID).Scan(&current); err != nil || current != 0 {
		t.Fatalf("stale disabled current reference: %d %v", current, err)
	}
	replacement, err := store.ClaimSkillPreparation(ctx, request.Scope, "preparer-2", now.Add(7*time.Second), time.Minute, 1)
	if err != nil || replacement == nil || replacement.Key.Materialization != prepared.Key.Materialization+1 || replacement.VolumeName == prepared.VolumeName {
		t.Fatalf("replacement: %+v %v", replacement, err)
	}
}

func TestDriftedRebuildTargetIsCleanedWhileSourceRuntimeRemainsActive(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	now := time.Now().UTC()
	organization := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(organization, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "drift-target-scope", RequestID: "drift-target-prepare", AgentID: "agent-drift-target",
		OrganizationID: organization, OwnerOperationID: "rebuild-target", LayoutVersion: 1, SkillSetDigest: digest}
	if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	job, err := store.ClaimSkillPreparation(ctx, request.Scope, "preparer", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim target: %+v %v", job, err)
	}
	manifest := "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if err := store.CompleteSkillPreparation(ctx, job.SetID, "preparer", manifest, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	receipt, err := store.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := store.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{Scope: request.Scope,
		OrganizationID: organization, AgentID: request.AgentID, SkillSetDigest: digest,
		LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID})
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
	if err := store.MarkDriftedReadySkillVolume(ctx, prepared); err != nil {
		t.Fatalf("noncurrent target drift did not enter cleanup: %v", err)
	}
	cleanup, err := store.ClaimSkillCleanup(ctx, request.Scope, "cleaner", now.Add(2*time.Second), time.Minute)
	if err != nil || cleanup == nil || cleanup.SetID != prepared.SetID {
		t.Fatalf("noncurrent target cleanup not claimed: %+v %v", cleanup, err)
	}
	if err := store.CompleteSkillCleanup(ctx, cleanup.SetID, "cleaner", now.Add(3*time.Second)); err != nil {
		t.Fatalf("noncurrent target cleanup not completed: %v", err)
	}
	after, err := store.GetSkillPreparation(ctx, request.Scope, organization, request.AgentID, request.RequestID)
	if err != nil || after.State != skillset.PreparationQueued || after.PreparedReferenceID != "" {
		t.Fatalf("target did not requeue: %+v %v", after, err)
	}
	var currentSetID int64
	if err := database.QueryRowContext(ctx, `SELECT set_id FROM runtime_controller.skill_current_references WHERE agent_id=$1`, request.AgentID).Scan(&currentSetID); err != nil || currentSetID != sourceSetID {
		t.Fatalf("source current reference changed: %d %v", currentSetID, err)
	}
}
