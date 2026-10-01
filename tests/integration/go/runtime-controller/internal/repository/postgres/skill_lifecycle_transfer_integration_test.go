package postgres

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestSkillLifecycleReferencesTransferOnSuccessAndReleaseOnFailureOrDelete(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	now := time.Now().UTC()
	agent := "agent-skill-transfer"
	prepare := func(org, suffix string) (int64, *skillset.PreparedReference) {
		t.Helper()
		digest, err := skillset.Digest(org, 1, nil)
		if err != nil {
			t.Fatal(err)
		}
		request := skillset.PrepareRequest{Scope: "transfer-scope", RequestID: "prepare-" + suffix, AgentID: agent, OrganizationID: org, OwnerOperationID: "owner-" + suffix, LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
		if _, err := store.AdmitSkillPreparation(ctx, request); err != nil {
			t.Fatal(err)
		}
		job, err := store.ClaimSkillPreparation(ctx, request.Scope, "worker-"+suffix, now, time.Minute, 1)
		if err != nil || job == nil {
			t.Fatalf("claim %s: %+v %v", suffix, job, err)
		}
		if err := store.CompleteSkillPreparation(ctx, job.SetID, "worker-"+suffix, "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", now.Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		receipt, err := store.GetSkillPreparation(ctx, request.Scope, org, agent, request.RequestID)
		if err != nil {
			t.Fatal(err)
		}
		return job.SetID, &skillset.PreparedReference{Scope: request.Scope, OrganizationID: org, AgentID: agent, SkillSetDigest: digest, LayoutVersion: 1, ReferenceID: receipt.PreparedReferenceID, SystemSkills: request.SystemSkills}
	}
	firstID, first := prepare("org_00000000000000000000000000000000", "first")
	secondID, second := prepare("org_11111111111111111111111111111111", "second")
	begin := func(id string, kind deployment.OperationKind, source deployment.Environment, target *skillset.PreparedReference) deployment.Operation {
		t.Helper()
		op := integrationOperation(id, kind, now)
		op.AgentID = agent
		op.SourceState, op.SourceRevision, op.SourceGeneration, op.SourceSpecDigest = source.LifecycleState, source.RuntimeRevision, source.Generation, source.SpecDigest
		if kind != deployment.OperationInitializeRuntime {
			op.ExpectedRevision = source.RuntimeRevision
		}
		op.Generation = source.Generation
		if op.CreatesCompute() {
			op.Generation++
			op.ImageReference = "antnest/runtime:latest"
			op.ImageID = integrationSpecDigest
		}
		transition, _, err := deployment.LifecycleTransition(kind, source.LifecycleState)
		if err != nil {
			t.Fatal(err)
		}
		op.Transition = transition
		op.PreparedReference = target
		accepted, replay, err := store.BeginTransition(ctx, op)
		if err != nil || replay {
			t.Fatalf("begin %s: %+v %v", id, accepted, err)
		}
		return accepted
	}
	complete := func(op deployment.Operation, state deployment.OperationState, lifecycle deployment.LifecycleState) deployment.Environment {
		t.Helper()
		op.State = state
		if state == deployment.OperationCompleted {
			op.Effect = deployment.EffectCompleted
			op.Inspection = integrationEnvironment(op, lifecycle, now.Add(time.Second))
		} else {
			op.Effect = deployment.EffectNotStarted
			op.ErrorCode = "platform_unavailable"
		}
		if _, err := store.CompleteOperation(ctx, op, nil); err != nil {
			t.Fatalf("complete %s: %v", op.RequestID, err)
		}
		env, err := store.GetEnvironment(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
		return env
	}
	assertRefs := func(current int64, operationID string, wantOperation int) {
		t.Helper()
		var setID int64
		if err := database.QueryRowContext(ctx, `SELECT set_id FROM runtime_controller.skill_current_references WHERE agent_id=$1`, agent).Scan(&setID); err != nil || setID != current {
			t.Fatalf("current Skill set=%d want=%d err=%v", setID, current, err)
		}
		var count int
		if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_lifecycle_references WHERE operation_request_id=$1`, operationID).Scan(&count); err != nil || count != wantOperation {
			t.Fatalf("operation Skill refs=%d want=%d err=%v", count, wantOperation, err)
		}
	}
	source := deployment.Environment{AgentID: agent, LifecycleState: deployment.LifecycleUninitialized}
	init := begin("skill-transfer-init", deployment.OperationInitializeRuntime, source, first)
	current := complete(init, deployment.OperationCompleted, deployment.LifecycleProvisioned)
	assertRefs(firstID, init.RequestID, 0)
	disable := begin("skill-transfer-disable", deployment.OperationDisableRuntime, current, nil)
	current = complete(disable, deployment.OperationCompleted, deployment.LifecycleDisabled)
	assertRefs(firstID, disable.RequestID, 0)
	enable := begin("skill-transfer-enable", deployment.OperationEnableRuntime, current, first)
	current = complete(enable, deployment.OperationCompleted, deployment.LifecycleProvisioned)
	assertRefs(firstID, enable.RequestID, 0)
	update := begin("skill-transfer-update", deployment.OperationUpdateRuntime, current, second)
	current = complete(update, deployment.OperationCompleted, deployment.LifecycleProvisioned)
	assertRefs(secondID, update.RequestID, 0)
	failed := begin("skill-transfer-failed-update", deployment.OperationUpdateRuntime, current, first)
	unknown := failed
	unknown.State, unknown.Effect = deployment.OperationUnknown, deployment.EffectUnknown
	if _, err := store.CompleteOperation(ctx, unknown, nil); err != nil {
		t.Fatal(err)
	}
	var pending int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_lifecycle_references WHERE operation_request_id=$1`, failed.RequestID).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("unknown operation lost recovery reference: %d %v", pending, err)
	}
	replayed, replay, err := store.BeginTransition(ctx, failed)
	if err != nil || !replay {
		t.Fatalf("unknown replay: %+v %v", replayed, err)
	}
	current = complete(replayed, deployment.OperationFailed, "")
	assertRefs(secondID, failed.RequestID, 0)
	deleteOp := begin("skill-transfer-delete", deployment.OperationDeleteRuntime, current, nil)
	complete(deleteOp, deployment.OperationCompleted, deployment.LifecycleDeleted)
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.skill_current_references WHERE agent_id=$1`, agent).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deleted Agent retained current Skill ref: %d %v", count, err)
	}
}
