package ports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestRuntimeConnectionRejectsEndpointsOutsideFrozenGrammar(t *testing.T) {
	for _, endpoint := range []string{
		"http://" + strings.Repeat("a", 1020) + "/mcp",
		"http://é-runtime:8093/mcp",
		"http://-runtime:8093/mcp",
		"http://runtime:0/mcp",
		"http://runtime:08093/mcp",
	} {
		t.Run(endpoint[:min(len(endpoint), 45)], func(t *testing.T) {
			require.False(t, validRuntimeConnectionEndpoint(endpoint))
		})
	}
}

func TestRuntimePrivatePublicationUsesSharedAcceptRejectVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/agent-acp/runtime-publication-fixtures.json")
	require.NoError(t, err)
	var fixtures struct {
		Vectors []struct {
			Name      string          `json:"name"`
			Accepting bool            `json:"accepting_runs"`
			Runtime   json.RawMessage `json:"runtime"`
			Valid     bool            `json:"valid"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	spec, execution := "spec-1", "execution-1"
	for _, vector := range fixtures.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			var runtime *ExecutionRuntime
			decoder := json.NewDecoder(bytes.NewReader(vector.Runtime))
			decoder.DisallowUnknownFields()
			decodeErr := decoder.Decode(&runtime)
			snapshot := ExecutionSnapshot{OrganizationID: "org-1", Revision: 1,
				Providers: []ExecutionProvider{{ConnectionID: "provider-1", ProviderKey: "deepseek", RequestProtocol: "openai_chat_completions", BaseURL: "https://api.deepseek.com", Enabled: true, CredentialRevision: "cred-1", Credential: &ExecutionCredential{Method: "api_key", Secret: "synthetic-provider-secret"}}},
				Models:    []ExecutionModel{{ModelProfileID: "model-1", ConnectionID: "provider-1", DisplayName: "Model", Enabled: true, ModelParameters: domain.ModelParameters{Model: "model", ContextWindow: 8192, MaxOutputTokens: 256}}},
				Agents: []ExecutionAgent{{AgentID: "agent-1", PrincipalIDs: []string{"owner-1"}, AccessRevision: "access-1", AcceptingRuns: vector.Accepting, DefaultModelProfileID: "model-1",
					DefaultAuthorization: domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}}, AuthorizationRevision: 1,
					AgentSpecRevision: &spec, ExecutionRevision: &execution, ContextPolicyVersion: "context-v1", SkillInstructions: []ExecutionSkill{}, MaxModelRequests: 16, Runtime: runtime}}}
			require.Equal(t, vector.Valid, decodeErr == nil && snapshot.ValidateForPublication() == nil)
		})
	}
}

func TestRuntimeCredentialUsesCanonicalSharedTokenVectorsAndSafeFormatting(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/runtime/instance-connection-fixtures.json")
	require.NoError(t, err)
	var fixtures struct {
		Tokens []struct {
			Name  string `json:"name"`
			Token string `json:"token"`
			Valid bool   `json:"valid"`
		} `json:"token_vectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	for _, vector := range fixtures.Tokens {
		t.Run(vector.Name, func(t *testing.T) {
			credential := RuntimeCredential{Caller: "agent-acp-service", Token: vector.Token}
			require.Equal(t, vector.Valid, credential.Valid())
			for _, format := range []string{"%v", "%+v", "%#v"} {
				require.NotContains(t, fmt.Sprintf(format, credential), vector.Token)
			}
		})
	}
}
