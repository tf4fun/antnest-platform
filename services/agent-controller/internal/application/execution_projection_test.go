package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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
			AgentSpecRevisionID: "spec-1", ExecutionRevisionID: "execution-1", RuntimeRevision: "rtv_11111111111111111111111111111111", RuntimeExecutionID: "boot-1", RuntimeMCPEndpoint: "http://antnest-runtime-agent-1:8093/mcp",
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
	require.Equal(t, "rtv_11111111111111111111111111111111", value.Agents[0].Runtime.RuntimeRevision)
}

func TestExecutionProjectionDisabledProviderStillCarriesCurrentCredential(t *testing.T) {
	source := executionSource(t)
	source.Providers[0].Enabled = false
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.False(t, value.Providers[0].Enabled)
	require.Equal(t, "credential-current", value.Providers[0].CredentialRevision)
	require.True(t, value.Agents[0].AcceptingRuns, "ACP owns model selection independently of lifecycle readiness")
	require.Equal(t, []string{"owner-1"}, value.Agents[0].PrincipalIDs)
}

func TestExecutionProjectionPreparingBindingAndBlockingReasons(t *testing.T) {
	for _, test := range []struct {
		name           string
		change         func(*ports.ExecutionAgentSource)
		reason         string
		historyGranted bool
	}{
		{name: "authorized pending binding", reason: "agent_preparing", historyGranted: true},
		{name: "revoked", reason: "agent_unavailable", change: func(source *ports.ExecutionAgentSource) {
			source.Agent.IdentityRevocationSequence = source.Agent.OwnerAuthorizationSequence + 1
		}},
		{name: "desired disabled", reason: "agent_unavailable", historyGranted: true, change: func(source *ports.ExecutionAgentSource) {
			source.Agent.DesiredState = domain.DesiredDisabled
		}},
		{name: "active operation", reason: "agent_unavailable", historyGranted: true, change: func(source *ports.ExecutionAgentSource) {
			source.Agent.ActiveOperationRequestID = "operation-rebuild"
		}},
		{name: "Runtime unhealthy", reason: "agent_unavailable", historyGranted: true, change: func(source *ports.ExecutionAgentSource) {
			source.Agent.RuntimeState = domain.RuntimeUnhealthy
		}},
		{name: "Runtime observation failure", reason: "agent_unavailable", historyGranted: true, change: func(source *ports.ExecutionAgentSource) {
			source.Agent.FailureStage = "runtime_observation"
		}},
		{name: "owner access inactive", reason: "agent_unavailable", change: func(source *ports.ExecutionAgentSource) {
			source.OwnerAccessGranted = false
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := executionSource(t)
			agent := &source.Agents[0].Agent
			agent.ExecutionRevisionID, agent.RuntimeExecutionID, agent.RuntimeMCPEndpoint = "", "", ""
			agent.RuntimeState = domain.RuntimeUnknown
			agent.ActiveOperationRequestID, agent.FailureStage = "", ""
			if test.change != nil {
				test.change(&source.Agents[0])
			}
			snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.Len(t, snapshot.Agents, 1)
			projection := snapshot.Agents[0]
			require.False(t, projection.AcceptingRuns)
			require.NotNil(t, projection.UnavailableReason)
			require.Equal(t, test.reason, *projection.UnavailableReason)
			if test.historyGranted {
				require.Equal(t, []string{agent.OwnerUserID}, projection.PrincipalIDs)
			} else {
				require.Empty(t, projection.PrincipalIDs)
			}
			require.Equal(t, executionNullable(agent.AgentSpecRevisionID), projection.AgentSpecRevision)
			require.Nil(t, projection.ExecutionRevision)
			require.Nil(t, projection.Runtime, "pending bindings must not acquire executable Runtime authority")
			require.Equal(t, source.Revision, snapshot.Revision)
		})
	}
}

func TestExecutionProjectionCompleteBindingDoesNotWaitForACK(t *testing.T) {
	// The execution source carries no applied-ACK proof. A complete binding must
	// already be publishable, so its own ACK cannot be a prerequisite to opening.
	source := executionSource(t)
	snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	require.Len(t, snapshot.Agents, 1)
	projection := snapshot.Agents[0]
	require.True(t, projection.AcceptingRuns)
	require.Nil(t, projection.UnavailableReason)
	require.Equal(t, []string{source.Agents[0].Agent.OwnerUserID}, projection.PrincipalIDs)
	require.Equal(t, executionNullable(source.Agents[0].Agent.AgentSpecRevisionID), projection.AgentSpecRevision)
	require.Equal(t, executionNullable(source.Agents[0].Agent.ExecutionRevisionID), projection.ExecutionRevision)
	require.NotNil(t, projection.Runtime)
	require.Equal(t, source.Agents[0].Agent.RuntimeExecutionID, projection.Runtime.RuntimeExecutionID)
	require.Equal(t, source.Revision, snapshot.Revision)
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
	require.Equal(t, "http://antnest-runtime-agent-1:8093/mcp", value.Agents[0].Runtime.MCPEndpoint)
	require.Empty(t, value.Agents[0].SkillInstructions, "Runtime owns dynamic Skill discovery")
}

func TestExecutionProjectionPublishesEffectivePolicyForExistingAndNewLegacyAgents(t *testing.T) {
	const effective = `{"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"before_output"}`
	for _, initial := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing Agent", true: "new first candidate"}[initial], func(t *testing.T) {
			source := executionSource(t)
			if initial {
				source.Agents[0].Agent.LifecycleState = domain.AgentNotCreated
				source.Agents[0].Agent.AgentSpecRevisionID = ""
				source.Agents[0].Agent.ExecutionRevisionID = ""
			}
			original, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			requireModelPolicyJSON(t, source.Agents[0].Spec.Snapshot, `{}`)
			published, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.Len(t, published.Agents, 1)
			requireModelPolicyJSON(t, published.Agents[0], effective)
			after, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			require.Equal(t, string(original), string(after), "effective defaults must not rewrite historical AgentSpec JSON")
			requireModelPolicyJSON(t, source.Agents[0].Spec.Snapshot, `{}`)
			require.Equal(t, source.Revision, published.Revision)
			require.Equal(t, !initial, published.Agents[0].AcceptingRuns)
			require.NoError(t, json.Unmarshal([]byte(`{"model_retry":{"max":0,"base_ms":1,"cap_ms":1},"failover":"never"}`), &published.Agents[0]))
			again, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			requireModelPolicyJSON(t, again.Agents[0], effective)
		})
	}
}

func TestExecutionProjectionPreservesExplicitPolicyAndCopiesOptionalValues(t *testing.T) {
	for _, policy := range []struct {
		name string
		body string
	}{
		{"explicit opt out and zero caps", `{"model_retry":{"max":0,"base_ms":200,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":0,"max_output_tokens":0,"max_cost_usd_micros":0}}`},
		{"explicit maximums", `{"model_retry":{"max":8,"base_ms":30000,"cap_ms":30000},"failover":"before_output","run_budget":{"max_input_tokens":9007199254740991,"max_output_tokens":1,"max_cost_usd_micros":9007199254740991}}`},
	} {
		t.Run(policy.name, func(t *testing.T) {
			source := executionSource(t)
			require.NoError(t, json.Unmarshal([]byte(policy.body), &source.Agents[0].Spec.Snapshot))
			original, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			published, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			requireModelPolicyJSON(t, published.Agents[0], policy.body)
			const changed = `{"model_retry":{"max":1,"base_ms":2,"cap_ms":3},"failover":"before_output","run_budget":{"max_input_tokens":9,"max_output_tokens":9,"max_cost_usd_micros":9}}`
			require.NoError(t, json.Unmarshal([]byte(changed), &published.Agents[0]))
			after, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			require.Equal(t, string(original), string(after), "published policy must not alias the persisted spec")
			again, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			requireModelPolicyJSON(t, again.Agents[0], policy.body)
			require.NoError(t, json.Unmarshal([]byte(changed), &source.Agents[0].Spec.Snapshot))
			requireModelPolicyJSON(t, again.Agents[0], policy.body)
			agentJSON, err := json.Marshal(again.Agents[0])
			require.NoError(t, err)
			require.NotContains(t, string(agentJSON), "synthetic-current-secret")
		})
	}
}

func TestExecutionProjectionRejectsInvalidStoredModelPolicyWithoutPartialSnapshot(t *testing.T) {
	for _, policy := range []string{
		`{"model_retry":{"max":9,"base_ms":1,"cap_ms":1}}`,
		`{"model_retry":{"max":1,"base_ms":2,"cap_ms":1}}`,
		`{"failover":"always"}`,
		`{"run_budget":{"max_cost_usd_micros":9007199254740992}}`,
	} {
		t.Run(policy, func(t *testing.T) {
			source := executionSource(t)
			if err := json.Unmarshal([]byte(policy), &source.Agents[0].Spec.Snapshot); err != nil {
				return
			}
			published, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.ErrorIs(t, err, ports.ErrInvalidExecutionConfiguration)
			require.Empty(t, published)
		})
	}
}

func requireModelPolicyJSON(t *testing.T, value any, policy string) {
	t.Helper()
	payload, err := json.Marshal(value)
	require.NoError(t, err)
	var actual, expected map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(payload, &actual))
	require.NoError(t, json.Unmarshal([]byte(policy), &expected))
	for _, field := range []string{"model_retry", "failover", "run_budget"} {
		got, present := actual[field]
		want, wanted := expected[field]
		require.Equal(t, wanted, present, "policy field %s presence in %s", field, payload)
		if wanted {
			require.JSONEq(t, string(want), string(got), "policy field %s", field)
		}
	}
}
