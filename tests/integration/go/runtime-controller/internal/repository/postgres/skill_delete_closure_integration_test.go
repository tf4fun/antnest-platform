package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestDeleteClosesSkillPreparationBeforePhysicalRuntimeRemoval(t *testing.T) {
	store, _, ctx := integrationRepository(t)
	now := time.Now().UTC()
	agent := "agent-delete-closure"
	init := integrationOperation("delete-closure-init", deployment.OperationInitializeRuntime, now)
	init.AgentID = agent
	init.Transition = deployment.LifecycleInitializing
	started, _, err := store.BeginTransition(ctx, init)
	if err != nil {
		t.Fatal(err)
	}
	started.State = deployment.OperationCompleted
	started.Effect = deployment.EffectCompleted
	started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now.Add(time.Second))
	if _, err := store.CompleteOperation(ctx, started, nil); err != nil {
		t.Fatal(err)
	}
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := skillset.PrepareRequest{Scope: "delete-scope", RequestID: "delete-preparation", AgentID: agent, OrganizationID: org, OwnerOperationID: "delete-owner", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
		t.Fatal(err)
	}
	job, err := store.ClaimSkillPreparation(ctx, request.Scope, "delete-worker", now, time.Minute, 1)
	if err != nil || job == nil {
		t.Fatalf("claim preparation: %+v %v", job, err)
	}
	deleteOp := integrationOperation("delete-closure-delete", deployment.OperationDeleteRuntime, now.Add(2*time.Second))
	deleteOp.AgentID = agent
	deleteOp.ExpectedRevision = started.RuntimeRevision
	deleteOp.SourceRevision = started.RuntimeRevision
	deleteOp.SourceState = deployment.LifecycleProvisioned
	deleteOp.SourceGeneration = started.Generation
	deleteOp.SourceSpecDigest = started.SpecDigest
	deleteOp.Generation = started.Generation
	deleteOp.Transition = deployment.LifecycleDeleting
	accepted, _, err := store.BeginTransition(ctx, deleteOp)
	if err != nil {
		t.Fatal(err)
	}
	newer := request
	newer.RequestID = "delete-late-preparation"
	newer.OwnerOperationID = "delete-late-owner"
	if _, err := store.AdmitSkillPreparation(ctx, newer); !errors.Is(err, repository.ErrSkillPreparationClosed) {
		t.Fatalf("deleted Agent admitted new Skill preparation: %v", err)
	}
	receipt, err := store.GetSkillPreparation(ctx, request.Scope, org, agent, request.RequestID)
	if err != nil || receipt.State != skillset.PreparationInvalidated || receipt.PreparedReferenceID != "" {
		t.Fatalf("in-flight preparation not canceled: %+v %v", receipt, err)
	}
	if err := store.RenewSkillPreparation(ctx, job.SetID, "delete-worker", now.Add(3*time.Second), time.Minute); !errors.Is(err, repository.ErrLockLost) {
		t.Fatalf("deleted Agent retained preparation lease: %v", err)
	}
	cleanup, err := store.ClaimSkillCleanup(ctx, request.Scope, "delete-cleaner", now.Add(3*time.Second), time.Minute)
	if err != nil || cleanup == nil || cleanup.VolumeName != job.VolumeName {
		t.Fatalf("abandoned candidate not collectible: %+v %v", cleanup, err)
	}
	unknown := accepted
	unknown.State, unknown.Effect = deployment.OperationUnknown, deployment.EffectUnknown
	if _, err := store.CompleteOperation(ctx, unknown, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AdmitSkillPreparation(ctx, newer); !errors.Is(err, repository.ErrSkillPreparationClosed) {
		t.Fatalf("unknown Delete reopened Skill preparation: %v", err)
	}
	accepted, _, err = store.BeginTransition(ctx, deleteOp)
	if err != nil {
		t.Fatalf("resume Delete: %v", err)
	}
	accepted.State = deployment.OperationCompleted
	accepted.Effect = deployment.EffectCompleted
	accepted.Inspection = integrationEnvironment(accepted, deployment.LifecycleDeleted, now.Add(4*time.Second))
	if _, err := store.CompleteOperation(ctx, accepted, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AdmitSkillPreparation(ctx, newer); !errors.Is(err, repository.ErrSkillPreparationClosed) {
		t.Fatalf("deleted tombstone admitted Skill preparation: %v", err)
	}
}
