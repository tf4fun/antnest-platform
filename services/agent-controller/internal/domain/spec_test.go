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
		Revision: 1, Model: validModel(), CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: model.ID(), SystemPrompt: "You are helpful.",
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
	if snapshot.Model.Model != "model-1" || snapshot.CredentialRef != "credential-1" {
		t.Fatalf("materialized wrong model revision: %+v", snapshot)
	}
	if snapshot.ContextPolicyVersion != "context-v1" {
		t.Fatalf("context policy = %q", snapshot.ContextPolicyVersion)
	}
	digest, err := spec.Digest()
	if err != nil || len(digest) != 64 {
		t.Fatalf("digest = %q, error = %v", digest, err)
	}

	payload, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if strings.Contains(string(payload), "skill") {
		t.Fatalf("Stage 2 spec exposes a Skill surface: %s", payload)
	}
}

func TestMaterializeAgentSpecRejectsCrossOrganizationOrWrongModelRevision(t *testing.T) {
	t.Parallel()

	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-2",
		Revision: 1, Model: validModel(), CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: "model-revision-2", SystemPrompt: "prompt",
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
		ModelProfileRevisionID: "model-revision-1", SystemPrompt: "prompt",
		MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: "future-policy",
	})
	if err == nil {
		t.Fatal("unknown context policy version was accepted")
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
