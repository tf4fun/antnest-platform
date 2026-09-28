package postgres

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestTemplateSkillVersionsPersistAcrossRevisionAndReplay(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	if _, err := repository.PutModelProfile(ctx, model); err != nil {
		t.Fatal(err)
	}
	template := integrationTemplateRecord(t, model.Revision)
	frozen := domain.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1}
	snapshot := template.Revision.Snapshot()
	snapshot.SkillSetDigest = ""
	snapshot.SkillRefs = []domain.FrozenSkill{frozen}
	template.Revision, err = domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.PutTemplate(ctx, template); err != nil {
		t.Fatal(err)
	}
	loaded, err := repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil || !reflect.DeepEqual(loaded.Snapshot().SkillRefs, []domain.FrozenSkill{frozen}) {
		t.Fatalf("frozen revision = %+v, %v", loaded.Snapshot().SkillRefs, err)
	}
	replay, found, err := repository.ReplayTemplateRequest(ctx, ports.CreateTemplateRequest, template.RequestID, template.RequestFingerprint)
	if err != nil || !found || !reflect.DeepEqual(replay.Revision.Snapshot().SkillRefs, []domain.FrozenSkill{frozen}) {
		t.Fatalf("replay = %+v, found %t, %v", replay.Revision.Snapshot().SkillRefs, found, err)
	}
	revised := integrationRevisedTemplateRecord(t, template, model.Revision)
	if _, err := repository.ReviseTemplate(ctx, 1, revised); err != nil {
		t.Fatal(err)
	}
	old, err := repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil || !reflect.DeepEqual(old.Snapshot().SkillRefs, []domain.FrozenSkill{frozen}) {
		t.Fatalf("old revision changed: %+v, %v", old.Snapshot().SkillRefs, err)
	}
	current, err := repository.GetTemplate(ctx, template.TemplateID)
	if err != nil || len(current.Revision.Snapshot().SkillRefs) != 0 {
		t.Fatalf("current revision did not replace Skill set: %+v, %v", current.Revision.Snapshot().SkillRefs, err)
	}
}
