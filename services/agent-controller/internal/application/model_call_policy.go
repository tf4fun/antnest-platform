package application

import (
	"context"
	"fmt"
	"reflect"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type ModelCallPolicyService struct {
	store ports.ModelCallPolicyStore
}

func NewModelCallPolicyService(store ports.ModelCallPolicyStore) *ModelCallPolicyService {
	return &ModelCallPolicyService{store: store}
}

type SetModelCallPolicyInput struct {
	RequestID        string             `json:"request_id"`
	OrganizationID   string             `json:"organization_id"`
	ActorPrincipalID string             `json:"actor_principal_id"`
	ExpectedRevision *int64             `json:"expected_revision"`
	UnknownCost      string             `json:"unknown_cost"`
	RunCaps          *domain.RunBudget  `json:"run_caps"`
	Daily            *domain.PeriodCaps `json:"daily"`
	Monthly          *domain.PeriodCaps `json:"monthly"`
}

func (input SetModelCallPolicyInput) mutation() ports.SetModelCallPolicy {
	return ports.SetModelCallPolicy{RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, ExpectedRevision: *input.ExpectedRevision,
		UnknownCost: input.UnknownCost,
		RunCaps:     *input.RunCaps.Clone(), Daily: *input.Daily.Clone(), Monthly: *input.Monthly.Clone()}
}

func (input SetModelCallPolicyInput) expected() domain.ModelCallPolicy {
	return domain.ModelCallPolicy{OrganizationID: input.OrganizationID, OrganizationBudget: domain.OrganizationBudget{
		Revision: *input.ExpectedRevision + 1, UnknownCost: input.UnknownCost,
		RunCaps: *input.RunCaps, Daily: *input.Daily, Monthly: *input.Monthly,
	}}
}

func (input SetModelCallPolicyInput) Valid() bool {
	return input.ExpectedRevision != nil && input.RunCaps != nil && input.Daily != nil && input.Monthly != nil &&
		input.mutation().Validate() == nil
}

func (service *ModelCallPolicyService) Get(ctx context.Context, organizationID string) (domain.ModelCallPolicy, error) {
	if !domain.ValidModelCallPolicyIdentifier(organizationID) {
		return domain.ModelCallPolicy{}, ErrInvalidInput
	}
	if service.store == nil {
		return domain.ModelCallPolicy{}, ErrDependencyUnavailable
	}
	policy, err := service.store.GetModelCallPolicy(ctx, organizationID)
	if err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("read model call policy: %w", err)
	}
	if policy.OrganizationID != organizationID || policy.Validate() != nil {
		return domain.ModelCallPolicy{}, ErrQueryContract
	}
	return policy, nil
}

func (service *ModelCallPolicyService) Set(ctx context.Context, input SetModelCallPolicyInput) (domain.ModelCallPolicy, error) {
	if !input.Valid() {
		return domain.ModelCallPolicy{}, ErrInvalidInput
	}
	if service.store == nil {
		return domain.ModelCallPolicy{}, ErrDependencyUnavailable
	}
	policy, err := service.store.SetModelCallPolicy(ctx, input.mutation())
	if err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("set model call policy: %w", err)
	}
	expected := input.expected()
	if policy.OrganizationID != input.OrganizationID || policy.Validate() != nil ||
		!reflect.DeepEqual(policy.OrganizationBudget, expected.OrganizationBudget) {
		return domain.ModelCallPolicy{}, ErrQueryContract
	}
	return policy, nil
}
