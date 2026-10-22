package ports

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type SetRuntimeBarrierRecoveryPolicy struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	ExpectedRevision int64  `json:"expected_revision"`
	Mode             string `json:"mode"`
	CooldownMS       int64  `json:"cooldown_ms"`
}

func (input SetRuntimeBarrierRecoveryPolicy) Validate() error {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(input.RequestID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(input.ActorPrincipalID) ||
		input.ExpectedRevision < 0 || input.ExpectedRevision > domain.RuntimeBarrierRecoveryMaxRevision {
		return fmt.Errorf("invalid Runtime barrier recovery policy mutation")
	}
	// Revision one checks a requested value independently of the logical default.
	return (domain.RuntimeBarrierRecoveryPolicy{OrganizationID: input.OrganizationID,
		Revision: 1, Mode: input.Mode, CooldownMS: input.CooldownMS}).Validate()
}

type RuntimeBarrierRecoveryPolicyStore interface {
	GetRuntimeBarrierRecoveryPolicy(context.Context, string) (domain.RuntimeBarrierRecoveryPolicy, error)
	SetRuntimeBarrierRecoveryPolicy(context.Context, SetRuntimeBarrierRecoveryPolicy) (domain.RuntimeBarrierRecoveryPolicy, error)
}
