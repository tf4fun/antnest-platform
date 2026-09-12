package application

import (
	"context"
	"errors"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type NetworkPolicyService struct {
	agents ports.NetworkAgentLookup
	egress ports.NetworkPolicyClient
}

func NewNetworkPolicyService(agents ports.NetworkAgentLookup, egress ports.NetworkPolicyClient) *NetworkPolicyService {
	return &NetworkPolicyService{agents: agents, egress: egress}
}

type AgentNetworkPolicyView struct {
	AgentID    string                `json:"agent_id"`
	Policy     DesiredNetworkPolicy  `json:"policy"`
	Attachment NetworkAttachmentView `json:"attachment"`
}

type DesiredNetworkPolicy struct {
	ports.NetworkPolicyRevision
	ResourceVersion uint64 `json:"resource_version"`
}

type NetworkAttachmentView struct {
	State           string `json:"state"`
	ResourceVersion uint64 `json:"resource_version"`
}

type SetAgentNetworkPolicyInput struct {
	AgentID          string `json:"-"`
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	ports.SetNetworkPolicy
}

func (service *NetworkPolicyService) GetAgentNetworkPolicy(ctx context.Context, organizationID, agentID string) (AgentNetworkPolicyView, error) {
	if err := service.checkAgent(ctx, organizationID, agentID); err != nil {
		return AgentNetworkPolicyView{}, err
	}
	assignment, err := service.egress.GetAgentPolicyAssignment(ctx, agentID)
	if err != nil {
		return AgentNetworkPolicyView{}, err
	}
	revision, err := service.egress.GetPolicyRevision(ctx, assignment.NetworkPolicyReference)
	if err != nil {
		return AgentNetworkPolicyView{}, err
	}
	attachment, err := service.egress.GetAgentNetwork(ctx, agentID)
	if err != nil {
		return AgentNetworkPolicyView{}, err
	}
	if attachment.State != ports.NetworkStateActive {
		return AgentNetworkPolicyView{}, &ports.DependencyError{Service: "runtime-egress", Code: "agent_network_unavailable"}
	}
	return AgentNetworkPolicyView{
		AgentID: agentID, Policy: DesiredNetworkPolicy{NetworkPolicyRevision: revision, ResourceVersion: assignment.ResourceVersion},
		Attachment: NetworkAttachmentView{State: attachment.AttachmentState, ResourceVersion: attachment.AttachmentResourceVersion},
	}, nil
}

func (service *NetworkPolicyService) SetAgentNetworkPolicy(ctx context.Context, input SetAgentNetworkPolicyInput) (ports.NetworkPolicyAssignment, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.ActorPrincipalID) ||
		!input.Valid() || input.ExpectedResourceVersion == 0 {
		return ports.NetworkPolicyAssignment{}, ErrInvalidInput
	}
	if err := service.checkAgent(ctx, input.OrganizationID, input.AgentID); err != nil {
		return ports.NetworkPolicyAssignment{}, err
	}
	return service.egress.SetAgentPolicyAssignment(ctx, input.AgentID, input.SetNetworkPolicy)
}

func (service *NetworkPolicyService) checkAgent(ctx context.Context, organizationID, agentID string) error {
	if !validIdentifier(organizationID) || !validIdentifier(agentID) {
		return ErrInvalidInput
	}
	agent, err := service.agents.GetAgent(ctx, agentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ErrAgentNotFound
	}
	if err != nil {
		return fmt.Errorf("read network policy Agent scope: %w", err)
	}
	if agent.AgentID != agentID {
		return ErrQueryContract
	}
	if agent.OrganizationID != organizationID || agent.DesiredState == domain.DesiredDeleted ||
		agent.LifecycleState == domain.AgentDeleting || agent.LifecycleState == domain.AgentDeleted {
		return ErrAgentNotFound
	}
	return nil
}
