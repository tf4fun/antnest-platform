package protocol

import (
	"fmt"
	"regexp"
	"strings"
)

type EffectState string

const (
	EffectCompleted  EffectState = "completed"
	EffectNotStarted EffectState = "not_started"
	EffectUnknown    EffectState = "unknown"

	NetworkRestricted   = "restricted"
	NetworkUnrestricted = "unrestricted"
)

type EffectOutcome struct {
	State  EffectState `json:"state"`
	Code   string      `json:"code,omitempty"`
	Detail string      `json:"detail,omitempty"`
}

func (o EffectOutcome) Validate() error {
	switch o.State {
	case EffectCompleted:
		if o.Code != "" || o.Detail != "" {
			return fmt.Errorf("completed outcome cannot contain an error")
		}
	case EffectNotStarted, EffectUnknown:
		if strings.TrimSpace(o.Code) == "" {
			return fmt.Errorf("failed outcome code is required")
		}
	default:
		return fmt.Errorf("invalid effect state %q", o.State)
	}
	return nil
}

type EnsureRequest struct {
	AgentID            string `json:"agent_id"`
	Generation         uint64 `json:"generation"`
	RuntimeInstanceID  string `json:"runtime_instance_id"`
	ImageRef           string `json:"image_ref"`
	NetworkMode        string `json:"network_mode"`
	NetworkPolicyEpoch uint64 `json:"network_policy_epoch"`
	TunnelIPv4         string `json:"tunnel_ipv4"`
	AllocatorEpoch     uint64 `json:"allocator_epoch"`
	AdvertisedEndpoint string `json:"advertised_endpoint"`
	EgressEndpoint     string `json:"egress_endpoint"`
	ManagementNetwork  string `json:"management_network"`
	DNSIPv4            string `json:"dns_ipv4"`
	BootstrapToken     string `json:"bootstrap_token"`
}

type RuntimeTarget struct {
	AgentID           string `json:"agent_id"`
	Generation        uint64 `json:"generation"`
	RuntimeInstanceID string `json:"runtime_instance_id"`
	ContainerID       string `json:"container_id,omitempty"`
}

type RemoveRequest struct {
	Target         RuntimeTarget `json:"target"`
	PurgeWorkspace bool          `json:"purge_workspace"`
}

type DriverResult struct {
	Outcome     EffectOutcome `json:"outcome"`
	ContainerID string        `json:"container_id,omitempty"`
}

var agentIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func ValidateAgentID(value string) error {
	if !agentIDPattern.MatchString(strings.TrimSpace(value)) {
		return fmt.Errorf("agent id must be 1-128 safe identifier characters")
	}
	return nil
}
