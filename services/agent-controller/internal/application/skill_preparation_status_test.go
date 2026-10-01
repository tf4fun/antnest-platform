package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type skillStatusClientStub struct {
	skillPreparationClientStub
	receipt ports.SkillPreparationReceipt
	err     error
	reads   int
}

func (stub *skillStatusClientStub) GetSkillPreparation(_ context.Context, _, _, _ string) (ports.SkillPreparationReceipt, error) {
	stub.reads++
	return stub.receipt, stub.err
}

func TestSkillPreparationStatusScopesBeforeAgentAdmission(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-1", OrganizationID: "org-1", AgentID: "agent-1", Kind: domain.OperationCreate,
		State: "preparing", TargetSpec: domain.AgentSpecSnapshot{SystemSkills: []domain.FrozenSkill{{UnpackedSize: 200}}}, UpdatedAt: time.Unix(100, 0).UTC()}}
	client := &skillStatusClientStub{receipt: ports.SkillPreparationReceipt{RequestID: skillPreparationRequestID("request-1", 0), OwnerOperationID: "request-1",
		AgentID: "agent-1", OrganizationID: "org-1", State: "retry_wait", Progress: ports.SkillPreparationProgress{VerifiedPackages: 0, TotalPackages: 1, VerifiedBytes: 0, TotalBytes: 200}}}
	service := &LifecycleService{skillIntents: intent, skillClient: client}
	if _, err := service.GetSkillPreparationStatus(context.Background(), "org-2", "request-1"); !errors.Is(err, ports.ErrNotFound) || client.reads != 0 {
		t.Fatalf("cross-organization preparation disclosed: %v reads=%d", err, client.reads)
	}
	status, err := service.GetSkillPreparationStatus(context.Background(), "org-1", "request-1")
	if err != nil || status.State != "retry_wait" || status.Progress.TotalBytes != 200 || client.reads != 1 {
		t.Fatalf("live preparation status = %+v, %v, reads=%d", status, err, client.reads)
	}
}

func TestSkillPreparationStatusDistinguishesNotYetSubmittedFromUnavailable(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-1", OrganizationID: "org-1", AgentID: "agent-1", Kind: domain.OperationCreate,
		State: "preparing", TargetSpec: domain.AgentSpecSnapshot{SystemSkills: []domain.FrozenSkill{{UnpackedSize: 200}}}}}
	client := &skillStatusClientStub{err: &ports.DependencyError{Service: "runtime-controller", Code: "preparation_not_found"}}
	service := &LifecycleService{skillIntents: intent, skillClient: client}
	status, err := service.GetSkillPreparationStatus(context.Background(), "org-1", "request-1")
	if err != nil || status.State != "preparing" || status.Progress.TotalPackages != 1 || status.Progress.TotalBytes != 200 {
		t.Fatalf("pre-admission status = %+v, %v", status, err)
	}
	client.err = errors.New("RC unavailable")
	if _, err := service.GetSkillPreparationStatus(context.Background(), "org-1", "request-1"); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("unavailable RC was reported as progress: %v", err)
	}
}

func TestSkillPreparationStatusUsesRetainedTerminalIntent(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-1", OrganizationID: "org-1", AgentID: "agent-1", Kind: domain.OperationRebuild,
		State: "released", TargetSpec: domain.AgentSpecSnapshot{SystemSkills: []domain.FrozenSkill{{UnpackedSize: 200}, {UnpackedSize: 100}}}}}
	client := &skillStatusClientStub{err: errors.New("RC has cleaned its receipt")}
	status, err := (&LifecycleService{skillIntents: intent, skillClient: client}).GetSkillPreparationStatus(context.Background(), "org-1", "request-1")
	if err != nil || status.State != "released" || status.Progress.VerifiedPackages != 2 || status.Progress.TotalBytes != 300 || client.reads != 0 {
		t.Fatalf("terminal status = %+v, %v, reads=%d", status, err, client.reads)
	}
}

func TestSkillPreparationStatusChecksReadyReferenceForExternalInvalidation(t *testing.T) {
	intent := &skillIntentStub{intent: ports.SkillPreparationIntent{RequestID: "request-1", OrganizationID: "org-1", AgentID: "agent-1", Kind: domain.OperationRebuild,
		State: "ready", TargetSpec: domain.AgentSpecSnapshot{SystemSkills: []domain.FrozenSkill{{UnpackedSize: 200}}}}}
	client := &skillStatusClientStub{receipt: ports.SkillPreparationReceipt{RequestID: skillPreparationRequestID("request-1", 0), OwnerOperationID: "request-1",
		AgentID: "agent-1", OrganizationID: "org-1", State: "invalidated", Progress: ports.SkillPreparationProgress{TotalPackages: 1, TotalBytes: 200}}}
	status, err := (&LifecycleService{skillIntents: intent, skillClient: client}).GetSkillPreparationStatus(context.Background(), "org-1", "request-1")
	if err != nil || status.State != "invalidated" || client.reads != 1 {
		t.Fatalf("drift was hidden: %+v, %v, reads=%d", status, err, client.reads)
	}
}
