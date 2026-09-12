package ports

import (
	"strings"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestValidateRunExecutionSnapshotRejectsIncompleteSnapshots(t *testing.T) {
	t.Parallel()

	valid := RunExecutionSnapshot{
		AgentSpecRevisionID: "spec-1", ExecutionRevisionID: "execution-1",
		RuntimeMCPSourceDigest:   strings.Repeat("a", 64),
		AgentExecutionSpecDigest: strings.Repeat("b", 64),
		Runtime: AdmittedRuntime{
			RuntimeRevision: "runtime-1", RuntimeExecutionID: "runtime-execution-1",
			MCPEndpoint: "http://runtime-1:8091/mcp",
		},
		ExecutionSpec: AdmittedExecutionSpec{
			ContextPolicyVersion: domain.ContextPolicyV1,
			SkillInstructions:    []SkillInstruction{},
			Model: domain.ModelSpec{
				BaseURL: "https://model.example/v1", Model: "model-1",
				ContextWindow: 32768, MaxOutputTokens: 4096,
			},
			MaxModelRequests: 16, Provider: domain.ProviderExecution{ConnectionID: "credential-1", ProviderKey: "deepseek", CredentialMethod: "api_key", RequestProtocol: "openai_chat_completions"},
		},
	}
	if err := ValidateRunExecutionSnapshot(valid); err != nil {
		t.Fatalf("valid snapshot: %v", err)
	}
	invalid := valid
	invalid.RuntimeMCPSourceDigest = strings.Repeat("g", 64)
	if err := ValidateRunExecutionSnapshot(invalid); err == nil {
		t.Fatal("accepted invalid digest")
	}
	invalid = valid
	invalid.ExecutionSpec.SkillInstructions = []SkillInstruction{{SkillKey: "premature"}}
	if err := ValidateRunExecutionSnapshot(invalid); err == nil {
		t.Fatal("accepted Stage 2 Skill instructions")
	}
}
