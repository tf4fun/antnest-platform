package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMaterializeAgentSpecUsesOneConsistentRevisionGraph(t *testing.T) {
	t.Parallel()

	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModel(),
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: model.Snapshot().ModelProfileID, SystemPrompt: "You are helpful.",
		MaxModelRequests: 32, Runtime: validRuntime(), ContextPolicyVersion: "context-v1",
	})
	if err != nil {
		t.Fatalf("create template revision: %v", err)
	}

	spec, err := MaterializeAgentSpec(template, model)
	if err != nil {
		t.Fatalf("materialize spec: %v", err)
	}
	snapshot := spec.Snapshot()
	if snapshot.Model.Model != "model-1" || snapshot.ModelProfileID != "model-1" {
		t.Fatalf("materialized wrong model revision: %+v", snapshot)
	}
	if snapshot.ContextPolicyVersion != "context-v1" {
		t.Fatalf("context policy = %q", snapshot.ContextPolicyVersion)
	}
	emptyDigest, err := SkillSetDigest("org-1", []FrozenSkill{})
	if err != nil || snapshot.SkillSetDigest != emptyDigest {
		t.Fatalf("empty Skill set digest = %q, want %q, error = %v", snapshot.SkillSetDigest, emptyDigest, err)
	}
	digest, err := spec.Digest()
	if err != nil || len(digest) != 64 {
		t.Fatalf("digest = %q, error = %v", digest, err)
	}

	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if strings.Contains(string(payload), "system_skills") {
		t.Fatalf("empty spec unexpectedly exposes system Skills: %s", payload)
	}
}

func TestTemplateFreezesSkillVersionsIntoAgentSpec(t *testing.T) {
	t.Parallel()
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModel(),
	})
	if err != nil {
		t.Fatal(err)
	}
	skill := FrozenSkill{
		SkillID: "skill_11111111111111111111111111111111", Version: 2,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1,
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 3,
		ModelProfileID: "model-1", MaxModelRequests: 8, Runtime: validRuntime(),
		ContextPolicyVersion: ContextPolicyV1, SkillRefs: []FrozenSkill{skill},
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := MaterializeAgentSpec(template, model)
	if err != nil {
		t.Fatal(err)
	}
	skill.Version = 99
	assertSkill := func(got FrozenSkill) {
		if got.Version != 2 || got.Name != "code-review" {
			t.Fatalf("frozen Skill changed: %+v", got)
		}
	}
	assertSkill(template.Snapshot().SkillRefs[0])
	assertSkill(first.Snapshot().SystemSkills[0])
	if template.Snapshot().SkillSetDigest == "" || first.Snapshot().SkillSetDigest != template.Snapshot().SkillSetDigest {
		t.Fatalf("Skill collection digest did not freeze: template=%q spec=%q", template.Snapshot().SkillSetDigest, first.Snapshot().SkillSetDigest)
	}
	snapshot := first.Snapshot()
	snapshot.SystemSkills[0].Name = "modified"
	assertSkill(first.Snapshot().SystemSkills[0])
	digest, err := first.Digest()
	if err != nil || len(digest) != 64 {
		t.Fatalf("digest = %q, %v", digest, err)
	}
}

func TestSkillSetDigestBindsOrganizationAndFrozenContent(t *testing.T) {
	t.Parallel()
	skill := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1}
	first, err := SkillSetDigest("org_00000000000000000000000000000000", []FrozenSkill{skill})
	if err != nil {
		t.Fatal(err)
	}
	if first != "sha256:50510ca3e153ba6eca18b35fbf11669bcc3ebe5ec373217a9089a84ac3f1cfc1" {
		t.Fatalf("unexpected canonical Skill digest: %s", first)
	}
	otherOrg, _ := SkillSetDigest("org-2", []FrozenSkill{skill})
	if first == otherOrg {
		t.Fatal("Skill collection digest ignored organization")
	}
	skill.Version++
	otherVersion, _ := SkillSetDigest("org-1", []FrozenSkill{skill})
	if first == otherVersion {
		t.Fatal("Skill collection digest ignored version")
	}
}

func TestTemplateRejectsDuplicateOrUnresolvedSkills(t *testing.T) {
	t.Parallel()
	skill := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: "code-review", Description: "Review code", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1}
	for _, refs := range [][]FrozenSkill{{skill, skill}, {{SkillID: skill.SkillID, Version: 1}},
		{skill, {SkillID: "skill_22222222222222222222222222222222", Version: 1,
			Name: skill.Name, Description: skill.Description, ArtifactDigest: skill.ArtifactDigest,
			ContentDigest: skill.ContentDigest, ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}}} {
		_, err := NewTemplateRevision(TemplateRevisionInput{
			TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
			ModelProfileID: "model-1", MaxModelRequests: 8, Runtime: validRuntime(),
			ContextPolicyVersion: ContextPolicyV1, SkillRefs: refs,
		})
		if err == nil {
			t.Fatalf("accepted invalid Skill refs: %+v", refs)
		}
	}
}

func TestTemplateNormalizesSkillOrder(t *testing.T) {
	t.Parallel()
	first := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: "first", Description: "First", ArtifactDigest: "sha256:" + strings.Repeat("a", 64),
		ContentDigest: "sha256:" + strings.Repeat("b", 64), ArtifactSize: 100, UnpackedSize: 200,
		PackageRulesVersion: 1}
	second := first
	second.SkillID, second.Name = "skill_22222222222222222222222222222222", "second"
	input := TemplateRevisionInput{TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: "model-1", MaxModelRequests: 8, Runtime: validRuntime(),
		ContextPolicyVersion: ContextPolicyV1, SkillRefs: []FrozenSkill{second, first}}
	template, err := NewTemplateRevision(input)
	if err != nil {
		t.Fatal(err)
	}
	if template.Snapshot().SkillRefs[0].SkillID != first.SkillID {
		t.Fatal("Skill refs not sorted by ID")
	}
	orderedDigest, _ := SkillSetDigest("org-1", []FrozenSkill{first, second})
	if template.Snapshot().SkillSetDigest != orderedDigest {
		t.Fatal("Skill digest depends on input order")
	}
}

func TestMaterializeAgentSpecRejectsCrossOrganizationOrWrongModelRevision(t *testing.T) {
	t.Parallel()

	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-2",
		Revision: 1, Model: validModel(),
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: "model-revision-2", SystemPrompt: "prompt",
		MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: "context-v1",
	})
	if err != nil {
		t.Fatalf("create template revision: %v", err)
	}
	if _, err := MaterializeAgentSpec(template, model); err == nil {
		t.Fatal("inconsistent revision graph was accepted")
	}
}

func TestTemplateRejectsUnknownContextPolicyVersion(t *testing.T) {
	t.Parallel()

	_, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: "model-revision-1", SystemPrompt: "prompt",
		MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: "future-policy",
	})
	if err == nil {
		t.Fatal("unknown context policy version was accepted")
	}
}

func TestModelProfileRejectsEndpointCredentialsQueryAndFragment(t *testing.T) {
	t.Parallel()

	for _, baseURL := range []string{
		"https://user:secret@api.example.com/v1",
		"https://api.example.com/v1?token=secret",
		"https://api.example.com/v1#fragment",
	} {
		model := validModel()
		model.BaseURL = baseURL
		_, err := NewModelProfileRevision(ModelProfileRevisionInput{
			ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
			Revision: 1, Model: model,
		})
		if err == nil {
			t.Errorf("unsafe Model endpoint %q was accepted", baseURL)
		}
	}
}

func validModel() ModelSpec {
	temperature := 0.4
	return ModelSpec{
		BaseURL: "https://api.example.com/v1", Model: "model-1",
		ContextWindow: 128000, MaxOutputTokens: 8192,
		Temperature: &temperature, SupportsImages: true,
	}
}

func validRuntime() RuntimeSpecInput {
	return RuntimeSpecInput{
		ImageRef: "antnest/runtime@sha256:" + strings.Repeat("a", 64),
		Resources: RuntimeResources{
			MemoryBytes: 512 * 1024 * 1024, PIDsLimit: 256, TmpfsBytes: 64 * 1024 * 1024,
		},
	}
}
