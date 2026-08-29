package protocol

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"
)

const (
	NetworkRestricted   = "restricted"
	NetworkUnrestricted = "unrestricted"
)

var ErrDataPlaneUnavailable = errors.New("runtime egress data plane is unavailable")

type GenerationKey struct {
	RuntimeInstanceID string `json:"runtime_instance_id"`
	Generation        uint64 `json:"generation"`
}

func (k GenerationKey) Validate() error {
	if strings.TrimSpace(k.RuntimeInstanceID) == "" || k.Generation == 0 {
		return fmt.Errorf("runtime instance id and positive generation are required")
	}
	return nil
}

type Reservation struct {
	GenerationKey
	AgentID        string     `json:"agent_id"`
	VirtualIP      netip.Addr `json:"virtual_ip"`
	AllocatorEpoch uint64     `json:"allocator_epoch"`
	NetworkMode    string     `json:"network_mode"`
	PolicyEpoch    uint64     `json:"policy_epoch"`
	PolicyRevision uint64     `json:"policy_revision"`
}

func (r Reservation) Validate() error {
	if err := r.GenerationKey.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(r.AgentID) == "" || !r.VirtualIP.Is4() || r.VirtualIP.IsUnspecified() {
		return fmt.Errorf("agent identity and usable virtual IPv4 address are required")
	}
	if r.AllocatorEpoch == 0 || r.PolicyEpoch == 0 || r.PolicyRevision == 0 {
		return fmt.Errorf("allocator and policy epochs must be positive")
	}
	if r.NetworkMode != NetworkUnrestricted {
		return fmt.Errorf("egress reservations require unrestricted network mode")
	}
	return nil
}

type TunnelClaims struct {
	Version            int         `json:"version"`
	Reservation        Reservation `json:"reservation"`
	RuntimeBootID      string      `json:"runtime_boot_id"`
	ConnectionEpoch    uint64      `json:"connection_epoch"`
	ExpiresAtUnixMilli int64       `json:"expires_at_unix_ms"`
}

func (c TunnelClaims) Validate(now time.Time) error {
	if c.Version != 1 || strings.TrimSpace(c.RuntimeBootID) == "" || c.ConnectionEpoch == 0 {
		return fmt.Errorf("tunnel claim identity is invalid")
	}
	if err := c.Reservation.Validate(); err != nil {
		return err
	}
	if c.ExpiresAtUnixMilli <= now.UTC().UnixMilli() {
		return fmt.Errorf("tunnel claim has expired")
	}
	return nil
}
