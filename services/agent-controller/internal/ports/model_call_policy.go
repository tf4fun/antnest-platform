package ports

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type SetModelCallPolicy struct {
	RequestID        string            `json:"request_id"`
	OrganizationID   string            `json:"organization_id"`
	ActorPrincipalID string            `json:"actor_principal_id"`
	ExpectedRevision int64             `json:"expected_revision"`
	UnknownCost      string            `json:"unknown_cost"`
	RunCaps          domain.RunBudget  `json:"run_caps"`
	Daily            domain.PeriodCaps `json:"daily"`
	Monthly          domain.PeriodCaps `json:"monthly"`
}

func (input SetModelCallPolicy) Validate() error {
	if !domain.ValidModelCallPolicyIdentifier(input.RequestID) ||
		!domain.ValidModelCallPolicyIdentifier(input.ActorPrincipalID) ||
		input.ExpectedRevision < 0 || input.ExpectedRevision > domain.MaximumModelBudget {
		return fmt.Errorf("invalid model call policy mutation")
	}
	return (domain.ModelCallPolicy{OrganizationID: input.OrganizationID,
		OrganizationBudget: domain.OrganizationBudget{Revision: 1, UnknownCost: input.UnknownCost,
			RunCaps: input.RunCaps, Daily: input.Daily, Monthly: input.Monthly}}).Validate()
}

type ModelCallPolicyStore interface {
	GetModelCallPolicy(context.Context, string) (domain.ModelCallPolicy, error)
	SetModelCallPolicy(context.Context, SetModelCallPolicy) (domain.ModelCallPolicy, error)
}
