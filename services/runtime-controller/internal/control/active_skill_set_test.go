package control

import (
	"context"
	"errors"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type activeSkillMountStub struct {
	store      *lifecycleRepository
	calls      int
	generation uint64
	specDigest string
	err        error
	changeHead bool
}

func (stub *activeSkillMountStub) VerifyActiveRuntimeMount(_ context.Context, _ skillset.PreparedMaterialization, generation uint64, specDigest string) error {
	stub.calls++
	stub.generation = generation
	stub.specDigest = specDigest
	if stub.changeHead {
		stub.store.mu.Lock()
		environment := stub.store.environments["agent-1"]
		environment.Generation++
		stub.store.environments["agent-1"] = environment
		stub.store.mu.Unlock()
	}
	return stub.err
}

func TestActiveSkillVerificationRequiresCurrentRuntimeAndPhysicalMount(t *testing.T) {
	store := newLifecycleRepository()
	service := newLifecycleService(t, store, newLifecyclePlatform())
	service.skillScope = "test-controller"
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, []skillset.FrozenSkill{})
	if err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: service.skillScope, OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	store.prepared = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name, ManifestDigest: lifecycleDigest}
	store.environments["agent-1"] = deployment.Environment{AgentID: "agent-1", RuntimeRevision: lifecycleRevision, LifecycleState: deployment.LifecycleProvisioned, Generation: 3, SpecDigest: lifecycleDigest}
	mount := &activeSkillMountStub{store: store}
	service.SetActiveSkillSetVerifier(store, mount)
	input := ActiveSkillSetVerificationRequest{OrganizationID: org, ExpectedRuntimeRevision: lifecycleRevision,
		PreparedReferenceID: "psr_" + strings.Repeat("a", 32), PreparedSkillSet: skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion},
		SystemSkills: []skillset.FrozenSkill{}}
	receipt, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input)
	if err != nil || receipt.RuntimeRevision != lifecycleRevision || receipt.SkillSetDigest != digest || receipt.ManifestDigest != lifecycleDigest || mount.calls != 1 || mount.generation != 3 || mount.specDigest != lifecycleDigest {
		t.Fatalf("active verification receipt=%+v err=%v mount=%+v", receipt, err, mount)
	}
	input.PreparedSkillSet.SkillSetDigest = lifecycleDigest
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, ErrInvalidRequest) || mount.calls != 1 {
		t.Fatalf("wrong digest admitted: %v", err)
	}
	input.PreparedSkillSet.SkillSetDigest = digest
	input.ExpectedRuntimeRevision = deployment.RuntimeRevision("rtv_ffffffffffffffffffffffffffffffff")
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, ErrRevisionConflict) || mount.calls != 1 {
		t.Fatalf("stale Runtime admitted: %v", err)
	}
	input.ExpectedRuntimeRevision = lifecycleRevision
	mount.err = errors.New("changed physical mount")
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, ErrDrift) {
		t.Fatalf("changed mount admitted: %v", err)
	}
	mount.err, mount.changeHead = nil, true
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("Environment changed during verification: %v", err)
	}
	delete(store.environments, "agent-1")
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing Runtime admitted: %v", err)
	}
	store.prepared = nil
	store.environments["agent-1"] = deployment.Environment{AgentID: "agent-1", RuntimeRevision: lifecycleRevision, LifecycleState: deployment.LifecycleProvisioned, Generation: 3, SpecDigest: lifecycleDigest}
	if _, err := service.VerifyActiveSkillSet(context.Background(), "agent-1", input); !errors.Is(err, repository.ErrPreparedSkillSetInvalidated) {
		t.Fatalf("released reference admitted: %v", err)
	}
}
