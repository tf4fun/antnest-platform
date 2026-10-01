package application

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestAgentLifecycleRejectsSkillTemplateUntilRuntimePreparationExists(t *testing.T) {
	t.Parallel()
	snapshot := mustLifecycleTemplate(t).Snapshot()
	snapshot.SkillSetDigest = ""
	snapshot.SkillRefs = []domain.FrozenSkill{{
		SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1,
	}}
	template, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	service := &LifecycleService{specs: lifecycleSpecSourceStub{template: template, model: mustLifecycleModel(t)}}
	_, _, _, err = service.resolveAgentSpecRevision(context.Background(), "org-1", snapshot.TemplateID, snapshot.Revision)
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("Skill template silently created unprepared Agent: %v", err)
	}
}
