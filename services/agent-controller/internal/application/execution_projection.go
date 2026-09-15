package application

import (
	"context"
	"fmt"
	"slices"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func BuildExecutionSnapshot(ctx context.Context, source ports.ExecutionSource, opener ports.CredentialOpener) (ports.ExecutionSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ports.ExecutionSnapshot{}, err
	}
	result := ports.ExecutionSnapshot{OrganizationID: source.OrganizationID, Revision: source.Revision,
		Providers: make([]ports.ExecutionProvider, 0, len(source.Providers)), Models: make([]ports.ExecutionModel, 0, len(source.Models)), Agents: make([]ports.ExecutionAgent, 0, len(source.Agents))}
	for _, provider := range source.Providers {
		if provider.OrganizationID != source.OrganizationID {
			return ports.ExecutionSnapshot{}, ports.ErrInvalidExecutionConfiguration
		}
		support, ok := domain.SupportedProvider(provider.ProviderKey)
		if !ok || provider.CredentialMethod != support.CredentialMethod {
			return ports.ExecutionSnapshot{}, ports.ErrInvalidExecutionConfiguration
		}
		secret, err := opener.Open(ctx, ports.CredentialIdentity{OrganizationID: provider.OrganizationID, CredentialRef: provider.ConnectionID, CredentialVersion: provider.CredentialVersion}, provider.SealedCredential)
		if err != nil {
			if err := ctx.Err(); err != nil {
				return ports.ExecutionSnapshot{}, err
			}
			return ports.ExecutionSnapshot{}, fmt.Errorf("open current execution credential: %w", ports.ErrInvalidExecutionConfiguration)
		}
		result.Providers = append(result.Providers, ports.ExecutionProvider{ConnectionID: provider.ConnectionID, ProviderKey: provider.ProviderKey, RequestProtocol: support.RequestProtocol, BaseURL: provider.BaseURL, Enabled: provider.Enabled,
			CredentialRevision: provider.CredentialVersion, Credential: &ports.ExecutionCredential{Method: provider.CredentialMethod, Secret: secret}})
	}
	for _, model := range source.Models {
		if model.OrganizationID != source.OrganizationID || model.Revision.OrganizationID() != source.OrganizationID || model.Revision.Snapshot().ModelProfileID != model.ModelProfileID {
			return ports.ExecutionSnapshot{}, ports.ErrInvalidExecutionConfiguration
		}
		result.Models = append(result.Models, ports.ExecutionModel{ModelParameters: model.Revision.Snapshot().Model.Parameters(), ModelProfileID: model.ModelProfileID, ConnectionID: model.ProviderConnectionID, DisplayName: model.DisplayName, Enabled: model.Enabled})
	}
	seenAgents := make(map[string]bool, len(source.Agents))
	for _, agent := range source.Agents {
		if agent.Agent.OrganizationID != source.OrganizationID || agent.Agent.AgentID == "" || seenAgents[agent.Agent.AgentID] {
			return ports.ExecutionSnapshot{}, ports.ErrInvalidExecutionConfiguration
		}
		seenAgents[agent.Agent.AgentID] = true
		if agent.Agent.LifecycleState == domain.AgentDeleted {
			continue
		}
		if !executionSpecMatchesAgent(agent) {
			return ports.ExecutionSnapshot{}, ports.ErrInvalidExecutionConfiguration
		}
		result.Agents = append(result.Agents, projectExecutionAgent(agent))
	}
	if err := result.Validate(); err != nil {
		return ports.ExecutionSnapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return ports.ExecutionSnapshot{}, err
	}
	return result, nil
}

func projectExecutionAgent(source ports.ExecutionAgentSource) ports.ExecutionAgent {
	agent := source.Agent
	spec := source.Spec.Snapshot
	result := ports.ExecutionAgent{AgentID: agent.AgentID, PrincipalIDs: []string{}, AccessRevision: agent.AccessRevision,
		DefaultModelProfileID: spec.ModelProfileID, DefaultAuthorization: source.Authorization, AuthorizationRevision: source.AuthorizationRevision,
		FallbackModelProfileIDs: slices.Clone(spec.FallbackModelProfileIDs),
		AgentSpecRevision:       executionNullable(agent.AgentSpecRevisionID), ExecutionRevision: executionNullable(agent.ExecutionRevisionID), OperationID: executionNullable(agent.ActiveOperationRequestID),
		SystemPrompt: spec.SystemPrompt, ContextPolicyVersion: spec.ContextPolicyVersion, MaxModelRequests: spec.MaxModelRequests, SkillInstructions: []ports.ExecutionSkill{}}
	result.DefaultAuthorization.ToolRules = append([]domain.ToolRule{}, source.Authorization.ToolRules...)
	if source.OwnerAccessGranted && !agent.IdentityRevoked() && agent.DesiredState != domain.DesiredDeleted {
		result.PrincipalIDs = append(result.PrincipalIDs, agent.OwnerUserID)
	}
	if agent.RuntimeRevision != "" && agent.RuntimeExecutionID != "" && agent.RuntimeMCPEndpoint != "" {
		result.Runtime = &ports.ExecutionRuntime{RuntimeRevision: agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID, MCPEndpoint: agent.RuntimeMCPEndpoint}
	}
	result.AcceptingRuns = len(result.PrincipalIDs) > 0 && agent.ExecutionReady()
	if !result.AcceptingRuns {
		reason := "agent_unavailable"
		result.UnavailableReason = &reason
	}
	return result
}

func executionSpecMatchesAgent(source ports.ExecutionAgentSource) bool {
	if source.Spec.AgentID != source.Agent.AgentID || source.Spec.ID == "" || source.Spec.Revision < 1 {
		return false
	}
	if source.Agent.AgentSpecRevisionID == "" {
		if source.Agent.ExecutionRevisionID != "" {
			return false
		}
		if source.Agent.LastSuccessfulExecutionRevisionID != "" {
			return source.RetainedSpec.AgentID == source.Agent.AgentID && source.RetainedSpec.ID == source.Spec.ID
		}
		// The first persisted candidate gives an unbuilt Agent its configuration,
		// but never establishes an executable revision or Runtime binding.
		return source.Spec.Revision == 1
	}
	return source.Spec.ID == source.Agent.AgentSpecRevisionID
}

func executionNullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
