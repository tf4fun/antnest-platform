package domain

import (
	"reflect"
	"testing"
)

func TestAuthorizationOverridesAreSourceScopedAndDoNotMutateDefaults(t *testing.T) {
	t.Parallel()
	rule := ToolRule{Source: "runtime", SourceID: "runtime", ToolName: "bash", Decision: "deny"}
	defaults := Authorization{Mode: AuthorizationApprove, ToolRules: []ToolRule{rule}}
	override := rule
	override.Decision = "allow"
	local := ToolRule{Source: "agent", SourceID: "agent", ToolName: "bash", Decision: "deny"}
	mode := AuthorizationChat
	got, err := ResolveAuthorization(defaults, SessionConfigurationOverrides{
		AuthorizationMode: &mode, ToolRules: []ToolRule{local, override},
	})
	if err != nil || got.Mode != AuthorizationChat || len(got.ToolRules) != 2 {
		t.Fatalf("resolved=%+v err=%v", got, err)
	}
	if got.ToolRules[0] != local || got.ToolRules[1] != override {
		t.Fatalf("rules not canonical or source-scoped: %+v", got.ToolRules)
	}
	if defaults.Mode != AuthorizationApprove || !reflect.DeepEqual(defaults.ToolRules, []ToolRule{rule}) {
		t.Fatal("resolution mutated defaults")
	}
	got.ToolRules[0].Decision = "allow"
	inherited, err := ResolveAuthorization(defaults, SessionConfigurationOverrides{})
	if err != nil || !reflect.DeepEqual(inherited, defaults) {
		t.Fatalf("inheritance=%+v err=%v", inherited, err)
	}
}

func TestSessionConfigurationRejectsInvalidOverrides(t *testing.T) {
	t.Parallel()
	empty, foreignMode := "", AuthorizationMode("administrator")
	rule := ToolRule{Source: "runtime", SourceID: "runtime", ToolName: "read", Decision: "allow"}
	for name, input := range map[string]SessionConfigurationOverrides{
		"empty model":     {ModelProfileID: &empty},
		"bad mode":        {AuthorizationMode: &foreignMode},
		"duplicate rules": {ToolRules: []ToolRule{rule, rule}},
		"wildcard":        {ToolRules: []ToolRule{{Source: "runtime", SourceID: "runtime", ToolName: "*", Decision: "allow"}}},
		"bad decision":    {ToolRules: []ToolRule{{Source: "agent", SourceID: "agent", ToolName: "update_plan", Decision: "ask"}}},
		"bad source":      {ToolRules: []ToolRule{{Source: "external", SourceID: "runtime", ToolName: "read", Decision: "allow"}}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := input.Validate(); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestExecutionConfigurationDigestTracksActualExecutionInputs(t *testing.T) {
	t.Parallel()
	model := ModelProfileRevisionSnapshot{ID: "revision", ModelProfileID: "profile",

		Model: ModelSpec{BaseURL: "https://example.test", Model: "model", ContextWindow: 8192, MaxOutputTokens: 1024}}
	auth := Authorization{Mode: AuthorizationAuto, ToolRules: []ToolRule{}}
	first, err := ExecutionConfigurationDigest(model, auth)
	if err != nil || len(first) != 64 {
		t.Fatalf("digest=%s err=%v", first, err)
	}
	for name, mutate := range map[string]func(*ModelProfileRevisionSnapshot, *Authorization){
		"model":   func(m *ModelProfileRevisionSnapshot, _ *Authorization) { m.Model.Model = "other" },
		"context": func(m *ModelProfileRevisionSnapshot, _ *Authorization) { m.Model.ContextWindow++ },
		"images":  func(m *ModelProfileRevisionSnapshot, _ *Authorization) { m.Model.SupportsImages = true },
		"audio":   func(m *ModelProfileRevisionSnapshot, _ *Authorization) { m.Model.SupportsAudio = true },
		"pdf":     func(m *ModelProfileRevisionSnapshot, _ *Authorization) { m.Model.SupportsPDF = true },
		"mode":    func(_ *ModelProfileRevisionSnapshot, a *Authorization) { a.Mode = AuthorizationChat },
	} {
		t.Run(name, func(t *testing.T) {
			m, a := model, auth
			mutate(&m, &a)
			got, err := ExecutionConfigurationDigest(m, a)
			if err != nil || got == first {
				t.Fatalf("change omitted from digest: %s %v", got, err)
			}
		})
	}
}
