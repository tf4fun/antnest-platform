package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type executionCredentialOpener struct {
	calls []ports.CredentialIdentity
	err   error
}

func (opener *executionCredentialOpener) Open(_ context.Context, identity ports.CredentialIdentity, _ ports.SealedSecret) (string, error) {
	opener.calls = append(opener.calls, identity)
	return "synthetic-current-secret", opener.err
}

func executionSource(t *testing.T) ports.ExecutionSource {
	t.Helper()
	model, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: "model-config-1", ModelProfileID: "model-1", OrganizationID: "org-1", Revision: 1,
		Model: domain.ModelSpec{BaseURL: "https://api.deepseek.com", Model: "current-model", ContextWindow: 8192, MaxOutputTokens: 1024},
	})
	require.NoError(t, err)
	return ports.ExecutionSource{
		OrganizationID: "org-1", Revision: 3,
		Providers: []ports.ProviderConnectionRecord{{OrganizationID: "org-1", ConnectionID: "provider-1", ProviderKey: "deepseek", BaseURL: "https://api.deepseek.com", CredentialMethod: "api_key", CredentialVersion: "credential-current", Enabled: true}},
		Models:    []ports.ModelProfileRecord{{OrganizationID: "org-1", ModelProfileID: "model-1", ProviderConnectionID: "provider-1", DisplayName: "Current model", Enabled: true, Revision: model}},
		Agents: []ports.ExecutionAgentSource{{OwnerAccessGranted: true, Agent: ports.AgentRecord{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "owner-1", AccessRevision: "access-1",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
			AgentSpecRevisionID: "spec-1", ExecutionRevisionID: "execution-1", RuntimeRevision: "runtime-1", RuntimeExecutionID: "boot-1", RuntimeMCPEndpoint: "http://runtime:8093/mcp",
		}, Spec: ports.AgentSpecRecord{ID: "spec-1", AgentID: "agent-1", Revision: 1, Snapshot: domain.AgentSpecSnapshot{ModelProfileID: "model-1", SystemPrompt: "Organization assistant", ContextPolicyVersion: domain.ContextPolicyV1, MaxModelRequests: 8,
			Model: domain.ModelSpec{Model: "obsolete-frozen-model"}}}, Authorization: domain.Authorization{Mode: domain.AuthorizationAuto, ToolRules: []domain.ToolRule{}}, AuthorizationRevision: 1}},
	}
}

func TestExecutionProjectionUsesCurrentCatalogAndCredentials(t *testing.T) {
	opener := &executionCredentialOpener{}
	value, err := BuildExecutionSnapshot(t.Context(), executionSource(t), opener)
	require.NoError(t, err)
	require.Equal(t, "current-model", value.Models[0].Model)
	require.Equal(t, "credential-current", value.Providers[0].CredentialRevision)
	require.Equal(t, "synthetic-current-secret", value.Providers[0].Credential.Secret)
	require.Equal(t, []ports.CredentialIdentity{{OrganizationID: "org-1", CredentialRef: "provider-1", CredentialVersion: "credential-current"}}, opener.calls)
	require.True(t, value.Agents[0].AcceptingRuns)
	require.Equal(t, []string{"owner-1"}, value.Agents[0].PrincipalIDs)
	require.Equal(t, "runtime-1", value.Agents[0].Runtime.RuntimeRevision)
}

func TestExecutionProjectionDisabledProviderStillCarriesCurrentCredential(t *testing.T) {
	source := executionSource(t)
	source.Providers[0].Enabled = false
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.False(t, value.Providers[0].Enabled)
	require.Equal(t, "credential-current", value.Providers[0].CredentialRevision)
	require.False(t, value.Agents[0].AcceptingRuns)
	require.Equal(t, []string{"owner-1"}, value.Agents[0].PrincipalIDs)
}

func TestExecutionProjectionUnavailableAgentsRetainHistoryGrant(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*ports.AgentRecord)
	}{
		{"not-created", func(a *ports.AgentRecord) {
			a.LifecycleState = domain.AgentNotCreated
			a.AgentSpecRevisionID = ""
			a.ExecutionRevisionID = ""
			a.RuntimeMCPEndpoint = ""
			a.RuntimeExecutionID = ""
		}},
		{"waiting", func(a *ports.AgentRecord) { a.RuntimeState = domain.RuntimeWaiting }},
		{"unhealthy", func(a *ports.AgentRecord) { a.RuntimeState = domain.RuntimeUnhealthy }},
		{"exited", func(a *ports.AgentRecord) { a.RuntimeState = domain.RuntimeExited }},
		{"disabled", func(a *ports.AgentRecord) {
			a.DesiredState = domain.DesiredDisabled
			a.ActivationState = domain.ActivationDisabled
		}},
		{"rebuilding", func(a *ports.AgentRecord) { a.ActiveOperationRequestID = "operation-1" }},
		{"incomplete-binding", func(a *ports.AgentRecord) { a.RuntimeMCPEndpoint = "" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			source := executionSource(t)
			change.apply(&source.Agents[0].Agent)
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.False(t, value.Agents[0].AcceptingRuns)
			require.NotNil(t, value.Agents[0].UnavailableReason)
			require.Equal(t, []string{"owner-1"}, value.Agents[0].PrincipalIDs)
		})
	}
}

func TestExecutionProjectionRevocationAndDeletion(t *testing.T) {
	source := executionSource(t)
	source.Agents[0].Agent.IdentityRevocationSequence = 2
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.Empty(t, value.Agents[0].PrincipalIDs)
	require.False(t, value.Agents[0].AcceptingRuns)
	source.Agents[0].Agent.LifecycleState = domain.AgentDeleted
	value, err = BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.Empty(t, value.Agents)
}

func TestExecutionProjectionRejectsInvalidSourcesWithoutPartialSnapshot(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*ports.ExecutionSource)
	}{
		{"foreign-provider", func(s *ports.ExecutionSource) { s.Providers[0].OrganizationID = "other" }},
		{"foreign-model", func(s *ports.ExecutionSource) { s.Models[0].OrganizationID = "other" }},
		{"foreign-agent", func(s *ports.ExecutionSource) { s.Agents[0].Agent.OrganizationID = "other" }},
		{"duplicate-model", func(s *ports.ExecutionSource) { s.Models = append(s.Models, s.Models[0]) }},
		{"missing-model", func(s *ports.ExecutionSource) { s.Models = nil }},
		{"missing-provider", func(s *ports.ExecutionSource) { s.Providers = nil }},
		{"bad-authorization", func(s *ports.ExecutionSource) { s.Agents[0].Authorization.Mode = "admin" }},
		{"unsafe-revision", func(s *ports.ExecutionSource) { s.Revision = 1 << 53 }},
	} {
		t.Run(change.name, func(t *testing.T) {
			source := executionSource(t)
			change.apply(&source)
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
			require.Empty(t, value.Providers)
			require.Empty(t, value.Agents)
		})
	}
}

func TestExecutionProjectionCredentialFailureCannotBecomeEmptyPublication(t *testing.T) {
	value, err := BuildExecutionSnapshot(t.Context(), executionSource(t), &executionCredentialOpener{err: errors.New("synthetic-private-failure")})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "synthetic-private-failure")
	require.Empty(t, value.Providers)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = BuildExecutionSnapshot(ctx, executionSource(t), &executionCredentialOpener{})
	require.ErrorIs(t, err, context.Canceled)
}

func TestExecutionProjectionRejectsDeletedAndLiveDuplicate(t *testing.T) {
	for _, deletedFirst := range []bool{true, false} {
		source := executionSource(t)
		deleted := source.Agents[0]
		deleted.Agent.LifecycleState = domain.AgentDeleted
		if deletedFirst {
			source.Agents = append([]ports.ExecutionAgentSource{deleted}, source.Agents...)
		} else {
			source.Agents = append(source.Agents, deleted)
		}
		value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
		require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
		require.Empty(t, value)
	}
}

func TestExecutionProjectionRejectsInvalidEndpoints(t *testing.T) {
	for _, endpoint := range []string{"http://:8093/mcp", "https://api.deepseek.com:65536", "https://[not-ipv6]/mcp"} {
		for _, runtime := range []bool{false, true} {
			source := executionSource(t)
			if runtime {
				source.Agents[0].Agent.RuntimeMCPEndpoint = endpoint
			} else {
				source.Providers[0].BaseURL = endpoint
			}
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration, endpoint)
			require.Empty(t, value)
		}
	}
	source := executionSource(t)
	source.Agents[0].Agent.RuntimeMCPEndpoint = "http://[::1]:8093/mcp"
	_, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
}

func TestExecutionProjectionRequiresCommittedAgentSpec(t *testing.T) {
	for _, change := range []struct {
		name  string
		apply func(*ports.ExecutionAgentSource)
	}{
		{"foreign Agent", func(s *ports.ExecutionAgentSource) { s.Spec.AgentID = "agent-other" }},
		{"uncommitted target", func(s *ports.ExecutionAgentSource) { s.Spec.ID = "next-spec"; s.Spec.Revision = 2 }},
		{"created without spec", func(s *ports.ExecutionAgentSource) { s.Agent.AgentSpecRevisionID = "" }},
		{"initial candidate not first revision", func(s *ports.ExecutionAgentSource) {
			s.Agent.AgentSpecRevisionID = ""
			s.Agent.LifecycleState = domain.AgentNotCreated
			s.Spec.Revision = 2
		}},
	} {
		t.Run(change.name, func(t *testing.T) {
			source := executionSource(t)
			change.apply(&source.Agents[0])
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
			require.Empty(t, value)
		})
	}
}

func TestExecutionProjectionRetainsConfigurationWithoutExecutionBinding(t *testing.T) {
	source := executionSource(t)
	agent := &source.Agents[0]
	agent.Agent.AgentSpecRevisionID, agent.Agent.ExecutionRevisionID = "", ""
	agent.Agent.LastSuccessfulExecutionRevisionID = "last-execution"
	agent.RetainedSpec = agent.Spec
	snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.Equal(t, agent.Spec.Snapshot.SystemPrompt, snapshot.Agents[0].SystemPrompt)
	require.False(t, snapshot.Agents[0].AcceptingRuns)
	require.Nil(t, snapshot.Agents[0].AgentSpecRevision)
	require.Nil(t, snapshot.Agents[0].ExecutionRevision)
	agent.Spec.ID = "uncommitted-target"
	_, err = BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
}

func TestExecutionProjectionRetainsNeverReadyConfigurationAfterFailure(t *testing.T) {
	source := executionSource(t)
	agent := &source.Agents[0]
	agent.Agent.AgentSpecRevisionID, agent.Agent.ExecutionRevisionID = "", ""
	agent.Agent.LastSuccessfulExecutionRevisionID = ""
	agent.Agent.DesiredState = domain.DesiredDisabled
	agent.RetainedSpec = agent.Spec
	snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.False(t, snapshot.Agents[0].AcceptingRuns)
	require.Nil(t, snapshot.Agents[0].AgentSpecRevision)
	require.Nil(t, snapshot.Agents[0].ExecutionRevision)
	require.Equal(t, agent.Spec.Snapshot.SystemPrompt, snapshot.Agents[0].SystemPrompt)
	agent.Spec.Revision = 2
	_, err = BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
}

func TestExecutionProjectionKeepsDeploymentMCPConfigurationOutOfAgentPayload(t *testing.T) {
	source := executionSource(t)
	source.Agents[0].Spec.Snapshot.Runtime.MCPServers = []domain.MCPServer{{
		ID: "internal-mcp", Command: "synthetic-deployment-command",
		Args: []string{"synthetic-private-argument"}, Env: map[string]string{"TOKEN": "synthetic-mcp-secret"},
	}}
	source.Providers[0].SealedCredential = ports.SealedSecret{Ciphertext: []byte("sealed-provider-material"), Nonce: []byte("sealed-nonce"), KeyVersion: "key-version"}
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	for _, secret := range []string{"synthetic-deployment-command", "synthetic-private-argument", "synthetic-mcp-secret", "sealed-provider-material", "sealed-nonce", "key-version", "ciphertext", "key_version", "mcp_servers"} {
		require.NotContains(t, string(encoded), secret)
	}
	agentPayload, err := json.Marshal(value.Agents)
	require.NoError(t, err)
	require.NotContains(t, string(agentPayload), "synthetic-current-secret")
	require.Equal(t, "synthetic-current-secret", value.Providers[0].Credential.Secret, "only the internal Provider section carries decrypted credentials")
	require.Equal(t, "http://runtime:8093/mcp", value.Agents[0].Runtime.MCPEndpoint)
	require.Empty(t, value.Agents[0].SkillInstructions, "Runtime owns dynamic Skill discovery")
}
