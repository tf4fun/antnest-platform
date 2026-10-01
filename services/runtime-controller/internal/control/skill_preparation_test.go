package control

import (
	"context"
	"errors"
	"testing"

	platformdocker "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

type fakeSkillPreparationStore struct {
	admitCalls int
	input      skillset.PrepareRequest
	receipt    skillset.PreparationReceipt
	err        error
	prepared   skillset.PreparedMaterialization
	resetCalls int
	resetErr   error
	driftCalls int
	driftErr   error
}

func (f *fakeSkillPreparationStore) AdmitSkillPreparation(_ context.Context, input skillset.PrepareRequest) (skillset.PreparationReceipt, error) {
	f.admitCalls++
	f.input = input
	return f.receipt, f.err
}

func (f *fakeSkillPreparationStore) GetSkillPreparation(_ context.Context, scope, org, agent, request string) (skillset.PreparationReceipt, error) {
	if scope != "scope-1" || org != "org_00000000000000000000000000000000" || agent != "agent-1" || request != "prepare-1" {
		return skillset.PreparationReceipt{}, errors.New("wrong scoped query")
	}
	return f.receipt, f.err
}

func (f *fakeSkillPreparationStore) ReleaseSkillPreparation(_ context.Context, scope, org, agent, request, owner string) error {
	if scope != "scope-1" || org != "org_00000000000000000000000000000000" || agent != "agent-1" || request != "prepare-1" || owner != "build-1" {
		return errors.New("wrong scoped release")
	}
	return f.err
}

func (f *fakeSkillPreparationStore) ResolvePreparedSkillSet(_ context.Context, reference skillset.PreparedReference) (skillset.PreparedMaterialization, error) {
	if reference.ReferenceID != f.receipt.PreparedReferenceID {
		return skillset.PreparedMaterialization{}, repository.ErrPreparedSkillSetInvalidated
	}
	return f.prepared, nil
}

func (f *fakeSkillPreparationStore) ResetMissingReadySkillVolume(_ context.Context, prepared skillset.PreparedMaterialization) error {
	f.resetCalls++
	if prepared.SetID != f.prepared.SetID {
		return repository.ErrInvariantConflict
	}
	if f.resetErr == nil {
		f.receipt.State = skillset.PreparationQueued
		f.receipt.PreparedSkillSet = nil
		f.receipt.PreparedReferenceID = ""
	}
	return f.resetErr
}

func (f *fakeSkillPreparationStore) MarkDriftedReadySkillVolume(_ context.Context, prepared skillset.PreparedMaterialization) error {
	f.driftCalls++
	if prepared.SetID != f.prepared.SetID {
		return repository.ErrInvariantConflict
	}
	if f.driftErr == nil {
		f.receipt.State = skillset.PreparationCleanupPending
		f.receipt.PreparedSkillSet = nil
		f.receipt.PreparedReferenceID = ""
	}
	return f.driftErr
}

func TestReadyContentDriftSchedulesCleanupBeforeReturningReceipt(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeSkillPreparationStore{receipt: skillset.PreparationReceipt{State: skillset.PreparationReady, PreparedReferenceID: "psr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PreparedSkillSet: &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}}, prepared: skillset.PreparedMaterialization{SetID: 7}}
	service, err := NewSkillPreparationService(store, "scope-1")
	if err != nil {
		t.Fatal(err)
	}
	inspector := &skillInspectorStub{err: platformdocker.ErrSkillCollectionDrift}
	service.SetReadyVerifier(store, inspector)
	input := skillset.PrepareRequest{OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	receipt, err := service.Prepare(context.Background(), "prepare-1", "agent-1", input)
	if err != nil || receipt.State != skillset.PreparationCleanupPending || store.driftCalls != 1 || store.resetCalls != 0 {
		t.Fatalf("content drift did not schedule owned cleanup: %+v %v drift=%d reset=%d", receipt, err, store.driftCalls, store.resetCalls)
	}
}

func TestMissingReadyVolumeRequeuesBeforeReturningPreparationReceipt(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeSkillPreparationStore{receipt: skillset.PreparationReceipt{State: skillset.PreparationReady, PreparedReferenceID: "psr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PreparedSkillSet: &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}}, prepared: skillset.PreparedMaterialization{SetID: 7}}
	service, err := NewSkillPreparationService(store, "scope-1")
	if err != nil {
		t.Fatal(err)
	}
	inspector := &skillInspectorStub{err: platformdocker.ErrSkillVolumeMissing}
	service.SetReadyVerifier(store, inspector)
	input := skillset.PrepareRequest{OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	receipt, err := service.Prepare(context.Background(), "prepare-1", "agent-1", input)
	if err != nil || receipt.State != skillset.PreparationQueued || receipt.PreparedReferenceID != "" || store.resetCalls != 1 || inspector.calls != 1 {
		t.Fatalf("missing ready volume was reused: receipt=%+v err=%v resets=%d checks=%d", receipt, err, store.resetCalls, inspector.calls)
	}
}

func TestReadyVolumeDriftNeverReturnsAReadyReceipt(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeSkillPreparationStore{receipt: skillset.PreparationReceipt{State: skillset.PreparationReady, PreparedReferenceID: "psr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PreparedSkillSet: &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}}, prepared: skillset.PreparedMaterialization{SetID: 7}}
	service, err := NewSkillPreparationService(store, "scope-1")
	if err != nil {
		t.Fatal(err)
	}
	inspector := &skillInspectorStub{err: platformdocker.ErrConflict}
	service.SetReadyVerifier(store, inspector)
	input := skillset.PrepareRequest{OrganizationID: org, OwnerOperationID: "build-1", LayoutVersion: skillset.LayoutVersion, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if receipt, err := service.Prepare(context.Background(), "prepare-1", "agent-1", input); !errors.Is(err, ErrSkillPreflightUnavailable) || receipt.State == skillset.PreparationReady || store.resetCalls != 0 {
		t.Fatalf("drift yielded a ready receipt: %+v %v resets=%d", receipt, err, store.resetCalls)
	}
}

func TestIndependentPreparationAdmissionValidatesBeforeStore(t *testing.T) {
	store := &fakeSkillPreparationStore{receipt: skillset.PreparationReceipt{State: skillset.PreparationQueued}}
	service, err := NewSkillPreparationService(store, "scope-1")
	if err != nil {
		t.Fatal(err)
	}
	organization := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(organization, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	input := skillset.PrepareRequest{OrganizationID: organization, OwnerOperationID: "build-1", LayoutVersion: 1, SkillSetDigest: digest, SystemSkills: []skillset.FrozenSkill{}}
	if _, err := service.Prepare(context.Background(), "prepare-1", "agent-1", input); err != nil {
		t.Fatal(err)
	}
	if store.admitCalls != 1 || store.input.Scope != "scope-1" || store.input.RequestID != "prepare-1" || store.input.AgentID != "agent-1" {
		t.Fatalf("preparation identity not injected: %+v", store.input)
	}
	input.SkillSetDigest = "sha256:wrong"
	if _, err := service.Prepare(context.Background(), "prepare-2", "agent-1", input); !errors.Is(err, ErrInvalidRequest) || store.admitCalls != 1 {
		t.Fatalf("invalid collection reached store: %v calls=%d", err, store.admitCalls)
	}
	if _, err := service.Get(context.Background(), organization, "agent-1", "prepare-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.Release(context.Background(), organization, "agent-1", "prepare-1", "build-1"); err != nil {
		t.Fatal(err)
	}
}
