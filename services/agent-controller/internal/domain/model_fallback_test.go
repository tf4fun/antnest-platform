package domain

import (
	"slices"
	"testing"
)

func TestTemplatePreservesIndependentOrderedModelFallback(t *testing.T) {
	input := TemplateRevisionInput{TemplateID: "template", OrganizationID: "org", Revision: 1,
		ModelProfileID: "model", FallbackModelProfileIDs: []string{"backup-b", "backup-a"},
		MaxModelRequests: 8, Runtime: validRuntime(), ContextPolicyVersion: ContextPolicyV1}
	revision, err := NewTemplateRevision(input)
	if err != nil {
		t.Fatal(err)
	}
	input.FallbackModelProfileIDs[0] = "changed"
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{ID: "revision", ModelProfileID: "model", OrganizationID: "org", Revision: 1, Model: validModel()})
	if err != nil {
		t.Fatal(err)
	}
	spec, err := MaterializeAgentSpec(revision, model)
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range [][]string{revision.Snapshot().FallbackModelProfileIDs, spec.Snapshot().FallbackModelProfileIDs} {
		if !slices.Equal(got, []string{"backup-b", "backup-a"}) {
			t.Fatalf("fallback order changed: %v", got)
		}
		got[0] = "mutated"
	}
	if spec.Snapshot().FallbackModelProfileIDs[0] != "backup-b" || revision.Snapshot().FallbackModelProfileIDs[0] != "backup-b" {
		t.Fatal("snapshot aliases mutable candidate slice")
	}
}

func TestTemplateRejectsInvalidModelFallback(t *testing.T) {
	for _, candidates := range [][]string{{"model"}, {"other", "other"}, {""}, {" bad "}} {
		_, err := NewTemplateRevision(TemplateRevisionInput{TemplateID: "template", OrganizationID: "org", Revision: 1,
			ModelProfileID: "model", FallbackModelProfileIDs: candidates, MaxModelRequests: 8,
			Runtime: validRuntime(), ContextPolicyVersion: ContextPolicyV1})
		if err == nil {
			t.Fatalf("invalid fallback accepted: %v", candidates)
		}
	}
}
