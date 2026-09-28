package control

import (
	"context"
	"errors"
	"fmt"
	"strings"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

// SkillPreparationService is deliberately independent of lifecycle Service.
// It never takes an Agent mutation lock or enters that mutation's deadline.
type SkillPreparationService struct {
	store      repository.SkillPreparationStore
	scope      string
	readyStore repository.ReadySkillSetStore
	verifier   ReadySkillCollectionVerifier
}

type ReadySkillCollectionVerifier interface {
	VerifyPreparedCollection(context.Context, skillset.PreparedMaterialization) error
}

func (s *SkillPreparationService) SetReadyVerifier(store repository.ReadySkillSetStore, verifier ReadySkillCollectionVerifier) {
	s.readyStore, s.verifier = store, verifier
}

func NewSkillPreparationService(store repository.SkillPreparationStore, scope string) (*SkillPreparationService, error) {
	if store == nil || strings.TrimSpace(scope) == "" || len(scope) > 200 {
		return nil, fmt.Errorf("skill preparation store and Controller scope are required")
	}
	return &SkillPreparationService{store: store, scope: scope}, nil
}

func (s *SkillPreparationService) Prepare(ctx context.Context, requestID, agentID string, input skillset.PrepareRequest) (skillset.PreparationReceipt, error) {
	input.Scope, input.RequestID, input.AgentID = s.scope, requestID, agentID
	if _, err := input.ValidateAndDigest(); err != nil {
		return skillset.PreparationReceipt{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	receipt, err := s.store.AdmitSkillPreparation(ctx, input)
	if err != nil || receipt.State != skillset.PreparationReady || receipt.PreparedReferenceID == "" {
		return receipt, err
	}
	if s.readyStore == nil || s.verifier == nil {
		return skillset.PreparationReceipt{}, ErrSkillPreflightUnavailable
	}
	prepared, err := s.readyStore.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{
		Scope: s.scope, OrganizationID: input.OrganizationID, AgentID: agentID,
		SkillSetDigest: input.SkillSetDigest, LayoutVersion: input.LayoutVersion,
		ReferenceID: receipt.PreparedReferenceID, SystemSkills: input.SystemSkills,
	})
	if err != nil {
		return skillset.PreparationReceipt{}, err
	}
	if err := s.verifier.VerifyPreparedCollection(ctx, prepared); err != nil {
		if errors.Is(err, platformdocker.ErrSkillCollectionDrift) {
			if markErr := s.readyStore.MarkDriftedReadySkillVolume(ctx, prepared); markErr != nil {
				return skillset.PreparationReceipt{}, fmt.Errorf("%w: %v", ErrSkillPreflightUnavailable, markErr)
			}
			return s.store.GetSkillPreparation(ctx, s.scope, input.OrganizationID, agentID, requestID)
		}
		if !errors.Is(err, platformdocker.ErrSkillVolumeMissing) {
			return skillset.PreparationReceipt{}, fmt.Errorf("%w: %v", ErrSkillPreflightUnavailable, err)
		}
		if err := s.readyStore.ResetMissingReadySkillVolume(ctx, prepared); err != nil {
			return skillset.PreparationReceipt{}, fmt.Errorf("%w: %v", ErrSkillPreflightUnavailable, err)
		}
		return s.store.GetSkillPreparation(ctx, s.scope, input.OrganizationID, agentID, requestID)
	}
	return receipt, nil
}

func (s *SkillPreparationService) Get(ctx context.Context, organizationID, agentID, requestID string) (skillset.PreparationReceipt, error) {
	return s.store.GetSkillPreparation(ctx, s.scope, organizationID, agentID, requestID)
}

func (s *SkillPreparationService) Release(ctx context.Context, organizationID, agentID, requestID, ownerOperationID string) error {
	return s.store.ReleaseSkillPreparation(ctx, s.scope, organizationID, agentID, requestID, ownerOperationID)
}
