package application

import (
	"context"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type RuntimeBarrierRecoveryPolicyService struct {
	store ports.RuntimeBarrierRecoveryPolicyStore
}

func NewRuntimeBarrierRecoveryPolicyService(store ports.RuntimeBarrierRecoveryPolicyStore) *RuntimeBarrierRecoveryPolicyService {
	return &RuntimeBarrierRecoveryPolicyService{store: store}
}

type SetRuntimeBarrierRecoveryPolicyInput struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
	Mode             string `json:"mode"`
	CooldownMS       int64  `json:"cooldown_ms"`
}

func (input SetRuntimeBarrierRecoveryPolicyInput) mutation() ports.SetRuntimeBarrierRecoveryPolicy {
	return ports.SetRuntimeBarrierRecoveryPolicy{RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, ExpectedRevision: *input.ExpectedRevision,
		Mode: input.Mode, CooldownMS: input.CooldownMS}
}

func (input SetRuntimeBarrierRecoveryPolicyInput) Valid() bool {
	return input.ExpectedRevision != nil && input.mutation().Validate() == nil
}

func (service *RuntimeBarrierRecoveryPolicyService) Get(ctx context.Context, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(organizationID) {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrInvalidInput
	}
	if service.store == nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrDependencyUnavailable
	}
	policy, err := service.store.GetRuntimeBarrierRecoveryPolicy(ctx, organizationID)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("read Runtime barrier recovery policy: %w", err)
	}
	if policy.OrganizationID != organizationID || policy.Validate() != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrQueryContract
	}
	return policy, nil
}

func (service *RuntimeBarrierRecoveryPolicyService) Set(ctx context.Context, input SetRuntimeBarrierRecoveryPolicyInput) (domain.RuntimeBarrierRecoveryPolicy, error) {
	if !input.Valid() {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrInvalidInput
	}
	if service.store == nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrDependencyUnavailable
	}
	policy, err := service.store.SetRuntimeBarrierRecoveryPolicy(ctx, input.mutation())
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("set Runtime barrier recovery policy: %w", err)
	}
	if policy.OrganizationID != input.OrganizationID || policy.Validate() != nil ||
		policy.Revision != *input.ExpectedRevision+1 || policy.Mode != input.Mode || policy.CooldownMS != input.CooldownMS {
		return domain.RuntimeBarrierRecoveryPolicy{}, ErrQueryContract
	}
	return policy, nil
}
