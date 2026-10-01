package control

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

type skillInspectorStub struct {
	err   error
	calls int
}

func (i *skillInspectorStub) InspectPreparedVolume(context.Context, skillset.PreparedMaterialization) error {
	i.calls++
	return i.err
}

func (i *skillInspectorStub) VerifyPreparedCollection(context.Context, skillset.PreparedMaterialization) error {
	i.calls++
	return i.err
}

func TestInitializeConsumesPreparedSkillSetBeforeCreatingRuntime(t *testing.T) {
	store := newLifecycleRepository()
	runtime := newLifecyclePlatform()
	service := newLifecycleService(t, store, runtime)
	service.skillScope = "test-controller"
	inspector := &skillInspectorStub{}
	service.skillInspector = inspector
	config := lifecycleConfiguration()
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	config.OrganizationID = org
	config.SystemSkills = []skillset.FrozenSkill{}
	config.PreparedSkillSet = &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}
	config.PreparedReferenceID = "psr_" + strings.Repeat("a", 32)
	_, err = service.InitializeRuntime(context.Background(), "initialize-prepared", "agent-1", config)
	if !errors.Is(err, repository.ErrPreparedSkillSetInvalidated) || runtime.createCalls != 0 || len(store.operations) != 0 {
		t.Fatalf("invalid reference admitted: err=%v creates=%d operations=%d", err, runtime.createCalls, len(store.operations))
	}
	key := skillset.SetKey{Scope: service.skillScope, OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	store.prepared = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name, ManifestDigest: lifecycleDigest}
	inspector.err = platformdocker.ErrSkillVolumeMissing
	_, err = service.InitializeRuntime(context.Background(), "initialize-prepared", "agent-1", config)
	if !errors.Is(err, ErrPreparedSkillSetInvalidated) || runtime.createCalls != 0 || len(store.operations) != 0 || inspector.calls != 1 {
		t.Fatalf("missing physical volume admitted: err=%v creates=%d operations=%d checks=%d", err, runtime.createCalls, len(store.operations), inspector.calls)
	}
	inspector.err = nil
	operation, err := service.InitializeRuntime(context.Background(), "initialize-prepared", "agent-1", config)
	if err != nil || operation.State != deployment.OperationCompleted || runtime.createCalls != 1 {
		t.Fatalf("prepared initialize: %+v %v", operation, err)
	}
	if store.preparedReference == nil || store.preparedReference.Scope != service.skillScope || store.preparedReference.ReferenceID != config.PreparedReferenceID {
		t.Fatalf("missing accepted reference: %+v", store.preparedReference)
	}
	actual := runtime.deployments[0]
	if actual.PreparedMaterialization == nil || actual.PreparedMaterialization.VolumeName != name || actual.PreparedSkills == nil {
		t.Fatalf("prepared volume not delivered: %+v", actual)
	}
}

func TestAcceptedSkillMountFailureReplayCannotBecomeNotStarted(t *testing.T) {
	store := newLifecycleRepository()
	runtime := newLifecyclePlatform()
	service := newLifecycleService(t, store, runtime)
	service.skillScope = "test-controller"
	service.skillInspector = &skillInspectorStub{}
	config := lifecycleConfiguration()
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	config.OrganizationID = org
	config.SystemSkills = []skillset.FrozenSkill{}
	config.PreparedSkillSet = &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}
	config.PreparedReferenceID = "psr_" + strings.Repeat("a", 32)
	key := skillset.SetKey{Scope: service.skillScope, OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	store.prepared = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name, ManifestDigest: lifecycleDigest}
	runtime.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "skill_mount_verification_failed"}
	first, err := service.InitializeRuntime(context.Background(), "mount-race", "agent-1", config)
	if err != nil || first.State != deployment.OperationUnknown || first.ErrorCode != "skill_mount_verification_failed" || runtime.createCalls != 1 {
		t.Fatalf("accepted mount failure did not remain unknown: %+v %v", first, err)
	}
	runtime.createOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "storage_ownership_conflict"}
	replayed, err := service.InitializeRuntime(context.Background(), "mount-race", "agent-1", config)
	if err != nil || replayed.State != deployment.OperationUnknown || replayed.Effect != deployment.EffectUnknown || replayed.ErrorCode != "storage_ownership_conflict" || replayed.Attempt != first.Attempt+1 {
		t.Fatalf("replay erased the accepted Docker side effect: %+v %v", replayed, err)
	}
	if len(store.operations) != 1 || store.preparedReference == nil {
		t.Fatalf("replay lost original operation or Skill reference: operations=%d reference=%+v", len(store.operations), store.preparedReference)
	}
	runtime.createOutcome = deployment.EffectOutcome{State: deployment.EffectCompleted}
	recovered, err := service.InitializeRuntime(context.Background(), "mount-race", "agent-1", config)
	if err != nil || recovered.State != deployment.OperationCompleted || recovered.Attempt != replayed.Attempt+1 || len(store.operations) != 1 {
		t.Fatalf("same accepted request did not recover after Skill volume repair: %+v %v", recovered, err)
	}
}
