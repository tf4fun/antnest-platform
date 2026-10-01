package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type skillResolverStub struct {
	items []domain.FrozenSkill
	err   error
	calls int
}

func (stub *skillResolverStub) Resolve(_ context.Context, _ string, refs []domain.SkillReference) ([]domain.FrozenSkill, error) {
	stub.calls++
	if len(refs) != 1 || refs[0].Version != 2 {
		return nil, errors.New("wrong resolve request")
	}
	return stub.items, stub.err
}

func TestTemplateSkillVersionFrozenAcrossRevisionsAndReplay(t *testing.T) {
	t.Parallel()
	store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
	ref := domain.SkillReference{SkillID: "skill_11111111111111111111111111111111", Version: 2}
	resolved := domain.FrozenSkill{SkillID: ref.SkillID, Version: 2, Name: "code-review", Description: "Review code",
		ArtifactDigest: "sha256:" + strings.Repeat("a", 64), ContentDigest: "sha256:" + strings.Repeat("b", 64),
		ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}
	resolver := &skillResolverStub{items: []domain.FrozenSkill{resolved}}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()}, WithSkillVersionResolver(resolver))
	input := CreateTemplateInput{RequestID: "create-skill-template", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal", ModelProfileID: "model-1", MaxModelRequests: 8,
		Runtime: validRuntimeInput(), ContextPolicyVersion: domain.ContextPolicyV1,
		SkillRefs: []domain.SkillReference{ref}}
	first, err := service.CreateTemplate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.SkillRefs) != 1 || first.SkillRefs[0].Version != 2 {
		t.Fatalf("created refs = %+v", first.SkillRefs)
	}
	store.templateReplay, store.replayFound = store.templateRecord, true
	resolver.err = errors.New("Registry unavailable")
	replay, err := service.CreateTemplate(context.Background(), input)
	if err != nil || replay.SkillRefs[0].Version != 2 || resolver.calls != 1 {
		t.Fatalf("replay resolved again: %+v, %v, calls %d", replay, err, resolver.calls)
	}
}

func TestTemplateRejectsUnresolvedSkillBeforePersistence(t *testing.T) {
	t.Parallel()
	store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
	resolver := &skillResolverStub{items: nil}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()}, WithSkillVersionResolver(resolver))
	_, err := service.CreateTemplate(context.Background(), CreateTemplateInput{
		RequestID: "create-skill-template", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal", ModelProfileID: "model-1", MaxModelRequests: 8,
		Runtime: validRuntimeInput(), ContextPolicyVersion: domain.ContextPolicyV1,
		SkillRefs: []domain.SkillReference{{SkillID: "skill_11111111111111111111111111111111", Version: 2}},
	})
	if !errors.Is(err, ErrInvalidReference) || store.templateRecord.TemplateID != "" {
		t.Fatalf("unresolved Skill persisted: %v, %+v", err, store.templateRecord)
	}
}
