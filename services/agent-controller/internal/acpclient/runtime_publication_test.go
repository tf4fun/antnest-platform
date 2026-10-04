package acpclient_test

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func runtimeSnapshot() ports.ExecutionSnapshot {
	value := snapshot()
	spec, execution := "spec1", "execution1"
	value.Models = []ports.ExecutionModel{{ModelProfileID: "model1", ConnectionID: "provider1", DisplayName: "Model", Enabled: true,
		ModelParameters: domain.ModelParameters{Model: "model", ContextWindow: 8192, MaxOutputTokens: 256}}}
	value.Agents = []ports.ExecutionAgent{{AgentID: "agent1", PrincipalIDs: []string{"owner1"}, AccessRevision: "access1", AcceptingRuns: true, DefaultModelProfileID: "model1",
		DefaultAuthorization: domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}}, AuthorizationRevision: 1,
		AgentSpecRevision: &spec, ExecutionRevision: &execution, ContextPolicyVersion: "context-v1", SkillInstructions: []ports.ExecutionSkill{}, MaxModelRequests: 16,
		Runtime: &ports.ExecutionRuntime{RuntimeRevision: "rtv_11111111111111111111111111111111", RuntimeExecutionID: "boot1", ConnectionID: "rci_22222222222222222222222222222222",
			MCPEndpoint: "http://antnest-runtime-agent1:8093/mcp", Credential: &ports.RuntimeCredential{Caller: "agent-acp-service", Token: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}}}
	return value
}

func TestPrivateRuntimePublicationReachesOnlyTheExecutionControlPayload(t *testing.T) {
	client := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/rpc/agent-acp/apply-execution-snapshot", r.URL.Path)
		require.Empty(t, r.Header.Get("Authorization"))
		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		assertContract(t, "execution-snapshot", raw)
		require.Contains(t, string(raw), runtimeSnapshot().Agents[0].Runtime.Credential.Token)
		writeResponse(t, w, 200, `{"organization_id":"org1","applied_revision":7}`)
	})
	_, err := client.ApplyExecutionSnapshot(t.Context(), runtimeSnapshot())
	require.NoError(t, err)
}

func TestExecutionClientRefusesIncompleteOrClosedPrivateAuthorityBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	client := newClient(t, func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(500) })
	for _, mutate := range []func(*ports.ExecutionSnapshot){
		func(s *ports.ExecutionSnapshot) { s.Agents[0].Runtime.Credential = nil },
		func(s *ports.ExecutionSnapshot) { s.Agents[0].Runtime.ConnectionID = "" },
		func(s *ports.ExecutionSnapshot) { s.Agents[0].Runtime.Credential.Token += "\n" },
		func(s *ports.ExecutionSnapshot) { s.Agents[0].Runtime.Credential.Caller = "runtime-controller" },
		func(s *ports.ExecutionSnapshot) { s.Agents[0].AcceptingRuns = false },
	} {
		value := runtimeSnapshot()
		mutate(&value)
		_, err := client.ApplyExecutionSnapshot(context.Background(), value)
		require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
	}
	require.Zero(t, calls.Load())
}
