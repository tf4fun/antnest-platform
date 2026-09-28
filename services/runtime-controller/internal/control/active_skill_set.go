package control

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type ActiveSkillSetVerificationRequest struct {
	OrganizationID          string                     `json:"organization_id"`
	ExpectedRuntimeRevision deployment.RuntimeRevision `json:"expected_runtime_revision"`
	PreparedReferenceID     string                     `json:"prepared_reference_id"`
	PreparedSkillSet        skillset.PreparedSet       `json:"prepared_skill_set"`
	SystemSkills            []skillset.FrozenSkill     `json:"system_skills"`
}

type ActiveSkillSetVerificationReceipt struct {
	AgentID         string                     `json:"agent_id"`
	RuntimeRevision deployment.RuntimeRevision `json:"runtime_revision"`
	SkillSetDigest  string                     `json:"skill_set_digest"`
	LayoutVersion   uint32                     `json:"layout_version"`
	ManifestDigest  string                     `json:"manifest_digest"`
	VerifiedAt      time.Time                  `json:"verified_at"`
}

type ActiveSkillMountVerifier interface {
	VerifyActiveRuntimeMount(context.Context, skillset.PreparedMaterialization, uint64, string) error
}

func (s *Service) SetActiveSkillSetVerifier(store repository.PreparedSkillReferenceStore, verifier ActiveSkillMountVerifier) {
	s.activeReferenceStore, s.activeMountVerifier = store, verifier
}

func (s *Service) VerifyActiveSkillSet(ctx context.Context, agentID string, input ActiveSkillSetVerificationRequest) (ActiveSkillSetVerificationReceipt, error) {
	if s.activeReferenceStore == nil || s.activeMountVerifier == nil {
		return ActiveSkillSetVerificationReceipt{}, ErrSkillPreflightUnavailable
	}
	if err := (deployment.Key{AgentID: agentID, Generation: 1}).Validate(); err != nil {
		return ActiveSkillSetVerificationReceipt{}, ErrInvalidRequest
	}
	digest, err := skillset.Digest(input.OrganizationID, input.PreparedSkillSet.LayoutVersion, input.SystemSkills)
	if err != nil || input.SystemSkills == nil || digest != input.PreparedSkillSet.SkillSetDigest ||
		deployment.ValidateRevision(input.ExpectedRuntimeRevision) != nil ||
		len(input.PreparedReferenceID) != 36 || !strings.HasPrefix(input.PreparedReferenceID, "psr_") {
		return ActiveSkillSetVerificationReceipt{}, ErrInvalidRequest
	}
	if _, err := hex.DecodeString(input.PreparedReferenceID[4:]); err != nil {
		return ActiveSkillSetVerificationReceipt{}, ErrInvalidRequest
	}
	first, err := s.repository.GetEnvironment(ctx, agentID)
	if err != nil {
		return ActiveSkillSetVerificationReceipt{}, err
	}
	if !activeSkillRuntimeMatches(first, agentID, input.ExpectedRuntimeRevision) || deployment.ValidateDigest(first.SpecDigest) != nil {
		return ActiveSkillSetVerificationReceipt{}, ErrRevisionConflict
	}
	prepared, err := s.activeReferenceStore.ResolvePreparedSkillSet(ctx, skillset.PreparedReference{
		Scope: s.skillScope, OrganizationID: input.OrganizationID, AgentID: agentID,
		SkillSetDigest: digest, LayoutVersion: input.PreparedSkillSet.LayoutVersion,
		ReferenceID: input.PreparedReferenceID, SystemSkills: input.SystemSkills,
	})
	if err != nil {
		return ActiveSkillSetVerificationReceipt{}, err
	}
	if prepared.Key.Scope != s.skillScope || prepared.Key.OrganizationID != input.OrganizationID || prepared.Key.AgentID != agentID ||
		prepared.Key.SkillSetDigest != digest || prepared.Key.LayoutVersion != input.PreparedSkillSet.LayoutVersion ||
		deployment.ValidateDigest(prepared.ManifestDigest) != nil {
		return ActiveSkillSetVerificationReceipt{}, repository.ErrPreparedSkillSetInvalidated
	}
	if err := s.activeMountVerifier.VerifyActiveRuntimeMount(ctx, prepared, first.Generation, first.SpecDigest); err != nil {
		return ActiveSkillSetVerificationReceipt{}, fmt.Errorf("%w: verify active Skill mount: %v", ErrDrift, err)
	}
	current, err := s.repository.GetEnvironment(ctx, agentID)
	if err != nil {
		return ActiveSkillSetVerificationReceipt{}, err
	}
	if !activeSkillRuntimeMatches(current, agentID, input.ExpectedRuntimeRevision) || current.Generation != first.Generation || current.SpecDigest != first.SpecDigest {
		return ActiveSkillSetVerificationReceipt{}, ErrRevisionConflict
	}
	return ActiveSkillSetVerificationReceipt{AgentID: agentID, RuntimeRevision: current.RuntimeRevision,
		SkillSetDigest: digest, LayoutVersion: input.PreparedSkillSet.LayoutVersion,
		ManifestDigest: prepared.ManifestDigest, VerifiedAt: s.now().UTC()}, nil
}

func activeSkillRuntimeMatches(value deployment.Environment, agentID string, revision deployment.RuntimeRevision) bool {
	return value.AgentID == agentID && value.RuntimeRevision == revision &&
		value.LifecycleState == deployment.LifecycleProvisioned && value.Generation > 0
}
