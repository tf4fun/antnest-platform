package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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
	Spec *ports.NetworkPolicySpec `json:"spec,omitempty"`
}

func (input *SetAgentNetworkPolicyInput) UnmarshalJSON(raw []byte) error {
	var fields struct {
		RequestID        json.RawMessage `json:"request_id"`
		OrganizationID   json.RawMessage `json:"organization_id"`
		ActorPrincipalID json.RawMessage `json:"actor_principal_id"`
		PolicyID         json.RawMessage `json:"policy_id"`
		Revision         json.RawMessage `json:"revision"`
		ExpectedVersion  json.RawMessage `json:"expected_resource_version"`
		Spec             json.RawMessage `json:"spec"`
	}
	if err := serviceauth.DecodeObject(raw, &fields); err != nil {
		return err
	}
	nullable := map[string]json.RawMessage{
		"request_id": fields.RequestID, "organization_id": fields.OrganizationID,
		"actor_principal_id": fields.ActorPrincipalID, "policy_id": fields.PolicyID,
		"revision": fields.Revision, "expected_resource_version": fields.ExpectedVersion,
		"spec": fields.Spec,
	}
	for name, value := range nullable {
		if value != nil && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("%s must not be null", name)
		}
	}
	if (fields.PolicyID != nil) != (fields.Revision != nil) {
		return fmt.Errorf("policy_id and revision are a complete reference tuple")
	}
	if fields.Spec != nil && (fields.PolicyID != nil || fields.Revision != nil) {
		return fmt.Errorf("spec and policy reference are mutually exclusive")
	}
	if fields.PolicyID == nil && fields.Spec == nil {
		return fmt.Errorf("a policy reference or spec is required")
	}
	var spec *ports.NetworkPolicySpec
	if fields.Spec != nil {
		var decoded ports.NetworkPolicySpec
		if err := json.Unmarshal(fields.Spec, &decoded); err != nil {
			return err
		}
		spec = &decoded
	}
	var decoded struct {
		RequestID        string `json:"request_id"`
		OrganizationID   string `json:"organization_id"`
		ActorPrincipalID string `json:"actor_principal_id"`
		ports.SetNetworkPolicy
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	fresh := SetAgentNetworkPolicyInput{
		AgentID:          input.AgentID,
		RequestID:        decoded.RequestID,
		OrganizationID:   decoded.OrganizationID,
		ActorPrincipalID: decoded.ActorPrincipalID,
		SetNetworkPolicy: decoded.SetNetworkPolicy,
		Spec:             spec,
	}
	*input = fresh
	return nil
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
		input.ExpectedResourceVersion == 0 {
		return ports.NetworkPolicyAssignment{}, ErrInvalidInput
	}
	if input.Spec != nil {
		if input.PolicyID != "" || input.Revision != 0 || !input.Spec.Valid() {
			return ports.NetworkPolicyAssignment{}, ErrInvalidInput
		}
	} else if !input.Valid() {
		return ports.NetworkPolicyAssignment{}, ErrInvalidInput
	}
	if err := service.checkAgent(ctx, input.OrganizationID, input.AgentID); err != nil {
		return ports.NetworkPolicyAssignment{}, err
	}
	if input.Spec != nil {
		writer, ok := service.egress.(ports.NetworkPolicyRevisionWriter)
		if !ok {
			return ports.NetworkPolicyAssignment{}, &ports.DependencyError{Service: "runtime-egress", Code: "control_plane_unavailable"}
		}
		ref, err := input.Spec.Reference(input.OrganizationID, input.AgentID)
		if err != nil {
			return ports.NetworkPolicyAssignment{}, ErrInvalidInput
		}
		revision, err := writer.PutPolicyRevision(ctx, ref, *input.Spec)
		if err != nil {
			return ports.NetworkPolicyAssignment{}, err
		}
		if revision.NetworkPolicyReference != ref || !revision.Spec.Equal(*input.Spec) {
			return ports.NetworkPolicyAssignment{}, &ports.DependencyError{Service: "runtime-egress", Code: "invalid_response"}
		}
		return service.egress.SetAgentPolicyAssignment(ctx, input.AgentID, ports.SetNetworkPolicy{
			NetworkPolicyReference:  ref,
			ExpectedResourceVersion: input.ExpectedResourceVersion,
		})
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
		agent.LifecycleState == domain.AgentDeleted {
		return ErrAgentNotFound
	}
	return nil
}
