package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestModelAndBuildSnapshotsContainNoCredentialConfiguration(t *testing.T) {
	t.Parallel()
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{ID: "revision", ModelProfileID: "model", OrganizationID: "org", Revision: 1, Model: validModel()})
	if err != nil {
		t.Fatal(err)
	}
	template, err := NewTemplateRevision(TemplateRevisionInput{TemplateID: "template", OrganizationID: "org", Revision: 1, ModelProfileID: "model", MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: ContextPolicyV1})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := MaterializeAgentSpec(template, model)
	if err != nil {
		t.Fatal(err)
	}
	for _, snapshot := range []any{model.Snapshot(), template.Snapshot(), spec.Snapshot()} {
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "credential") {
			t.Fatal("model or build snapshot owns credentials")
		}
	}
	updated := model.Snapshot()
	updated.ID, updated.Revision, updated.Model.ContextWindow = "revision-next", 2, 4096
	revision, err := NewModelProfileRevision(ModelProfileRevisionInput(updated))
	if err != nil {
		t.Fatal(err)
	}
	next, err := MaterializeAgentSpec(template, revision)
	if err != nil || next.Snapshot().ModelProfileID != spec.Snapshot().ModelProfileID || next.Snapshot().Model.ContextWindow != 4096 {
		t.Fatal("template does not follow its model identity")
	}
	updated.ModelProfileID = "other-model"
	foreign, err := NewModelProfileRevision(ModelProfileRevisionInput(updated))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := MaterializeAgentSpec(template, foreign); err == nil {
		t.Fatal("template switched to unrelated model")
	}
}

func TestSupportedProviderDefinesCurrentCompatibility(t *testing.T) {
	t.Parallel()
	support, ok := SupportedProvider("deepseek")
	if !ok || support.CredentialMethod != "api_key" || support.RequestProtocol != "openai_chat_completions" {
		t.Fatalf("unexpected support: %+v %t", support, ok)
	}
	for _, key := range []string{"", "custom", " deepseek"} {
		if _, ok := SupportedProvider(key); ok {
			t.Fatalf("unsupported Provider %q accepted", key)
		}
	}
}
