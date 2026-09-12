package ports

import "context"

// NetworkPolicyReference addresses an immutable Egress-owned revision.
type NetworkPolicyReference struct {
	PolicyID string `json:"policy_id"`
	Revision uint64 `json:"revision"`
}

func (ref NetworkPolicyReference) Valid() bool {
	if ref.Revision == 0 || len(ref.PolicyID) == 0 || len(ref.PolicyID) > 255 {
		return false
	}
	for _, value := range []byte(ref.PolicyID) {
		if value < '!' || value > '~' {
			return false
		}
	}
	return true
}

type NetworkPolicySpec struct {
	SchemaVersion int    `json:"schema_version"`
	Action        string `json:"action"`
}

type NetworkPolicyRevision struct {
	NetworkPolicyReference
	Spec   NetworkPolicySpec `json:"spec"`
	Digest string            `json:"digest"`
}

type NetworkPolicyAssignment struct {
	AgentID string `json:"agent_id"`
	NetworkPolicyReference
	ResourceVersion uint64 `json:"resource_version"`
}

type SetNetworkPolicy struct {
	NetworkPolicyReference
	ExpectedResourceVersion uint64 `json:"expected_resource_version"`
}

type NetworkAgentLookup interface {
	GetAgent(context.Context, string) (AgentRecord, error)
}

type NetworkPolicyClient interface {
	GetAgentNetwork(context.Context, string) (NetworkAttachment, error)
	GetAgentPolicyAssignment(context.Context, string) (NetworkPolicyAssignment, error)
	GetPolicyRevision(context.Context, NetworkPolicyReference) (NetworkPolicyRevision, error)
	SetAgentPolicyAssignment(context.Context, string, SetNetworkPolicy) (NetworkPolicyAssignment, error)
}
