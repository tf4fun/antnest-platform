package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// SkillPreparationStatus exposes only the progress needed to retry the same
// lifecycle intent; it never exposes the frozen spec or RC's reference token.
type SkillPreparationStatus struct {
	RequestID  string                         `json:"request_id"`
	AgentID    string                         `json:"agent_id"`
	Kind       domain.OperationKind           `json:"kind"`
	State      string                         `json:"state"`
	Progress   ports.SkillPreparationProgress `json:"progress"`
	RetryAfter *time.Time                     `json:"retry_after,omitempty"`
	ErrorCode  string                         `json:"error_code,omitempty"`
	UpdatedAt  time.Time                      `json:"updated_at"`
}

func (service *LifecycleService) GetSkillPreparationStatus(ctx context.Context, organizationID, requestID string) (SkillPreparationStatus, error) {
	if organizationID == "" || requestID == "" {
		return SkillPreparationStatus{}, ErrInvalidInput
	}
	if service.skillIntents == nil {
		return SkillPreparationStatus{}, fmt.Errorf("%w: Skill preparation is not configured", ErrDependencyUnavailable)
	}
	intent, err := service.skillIntents.GetSkillPreparationIntent(ctx, requestID)
	if err != nil {
		return SkillPreparationStatus{}, err
	}
	if intent.OrganizationID != organizationID {
		return SkillPreparationStatus{}, ports.ErrNotFound
	}
	status := SkillPreparationStatus{RequestID: intent.RequestID, AgentID: intent.AgentID,
		Kind: intent.Kind, State: intent.State, UpdatedAt: intent.UpdatedAt}
	for _, skill := range intent.TargetSpec.SystemSkills {
		status.Progress.TotalPackages++
		status.Progress.TotalBytes += skill.UnpackedSize
	}
	if intent.State == "released" {
		status.Progress.VerifiedPackages = status.Progress.TotalPackages
		status.Progress.VerifiedBytes = status.Progress.TotalBytes
		return status, nil
	}
	if intent.State != "preparing" && intent.State != "ready" {
		return status, nil
	}
	if service.skillClient == nil {
		return SkillPreparationStatus{}, fmt.Errorf("%w: Runtime Controller Skill client is unavailable", ErrDependencyUnavailable)
	}
	preparationID := skillPreparationRequestID(intent.RequestID, intent.PreparationAttempt)
	receipt, err := service.skillClient.GetSkillPreparation(ctx, intent.OrganizationID, intent.AgentID, preparationID)
	if err != nil {
		var dependency *ports.DependencyError
		if intent.State == "preparing" && errors.As(err, &dependency) && dependency.Code == "preparation_not_found" {
			// The Controller intent is durable before the first RC request arrives.
			return status, nil
		}
		return SkillPreparationStatus{}, fmt.Errorf("%w: query Runtime Controller Skill preparation: %v", ErrDependencyUnavailable, err)
	}
	if receipt.RequestID != preparationID || receipt.OwnerOperationID != intent.RequestID || receipt.AgentID != intent.AgentID || receipt.OrganizationID != intent.OrganizationID ||
		receipt.Progress.TotalPackages != status.Progress.TotalPackages || receipt.Progress.TotalBytes != status.Progress.TotalBytes {
		return SkillPreparationStatus{}, fmt.Errorf("%w: Runtime Controller Skill preparation identity differs", ErrDependencyUnavailable)
	}
	status.State, status.Progress, status.RetryAfter, status.ErrorCode = receipt.State, receipt.Progress, receipt.RetryAfter, receipt.ErrorCode
	return status, nil
}

func (service *LifecycleService) existingSkillPreparation(ctx context.Context, requestID, fingerprint string, kind domain.OperationKind, agentID, organizationID string) (ports.SkillPreparationIntent, bool, error) {
	if service.skillIntents == nil {
		return ports.SkillPreparationIntent{}, false, nil
	}
	intent, err := service.skillIntents.GetSkillPreparationIntent(ctx, requestID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.SkillPreparationIntent{}, false, nil
	}
	if err != nil {
		return ports.SkillPreparationIntent{}, false, fmt.Errorf("load Skill preparation intent: %w", err)
	}
	if intent.RequestFingerprint != fingerprint || intent.Kind != kind || intent.AgentID != agentID || intent.OrganizationID != organizationID {
		return ports.SkillPreparationIntent{}, false, ports.ErrRequestConflict
	}
	return intent, true, nil
}

func skillPreparationRequestID(operationID string, attempt uint32) string {
	if attempt == 0 {
		return domain.DeriveResourceID("request", "skill-prepare", operationID)
	}
	return domain.DeriveResourceID("request", "skill-prepare", fmt.Sprintf("%s/%d", operationID, attempt))
}

// prepareAgentSkills runs before any lifecycle admission that can drain or
// isolate an Agent. Temporal retries this activity while RC prepares the set.
func (service *LifecycleService) prepareAgentSkills(ctx context.Context, candidate ports.SkillPreparationIntent) (ports.SkillPreparationIntent, error) {
	if service.skillIntents == nil || service.skillClient == nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: Skill preparation is not configured", ErrDependencyUnavailable)
	}
	intent, err := service.skillIntents.ReserveSkillPreparation(ctx, candidate)
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("reserve Skill preparation: %w", err)
	}
	if intent.State == "abandoned" {
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: Skill preparation was rejected", ErrInvalidReference)
	}
	if intent.State == "invalidated" {
		if err := service.skillClient.ReleaseSkillPreparation(ctx,
			domain.DeriveResourceID("request", "skill-release-invalidated", fmt.Sprintf("%s/%d", intent.RequestID, intent.PreparationAttempt)),
			intent.OrganizationID, intent.AgentID, skillPreparationRequestID(intent.RequestID, intent.PreparationAttempt), intent.RequestID); err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("%w: release invalidated Skill preparation: %v", ErrDependencyUnavailable, err)
		}
		intent, err = service.skillIntents.AdvanceSkillPreparationAttempt(ctx, intent.RequestID, intent.RequestFingerprint, intent.PreparationAttempt, service.clock.Now())
		if err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("advance invalidated Skill preparation: %w", err)
		}
	}
	requestID := skillPreparationRequestID(intent.RequestID, intent.PreparationAttempt)
	receipt, err := service.skillClient.PrepareSkillSet(ctx, requestID, intent.AgentID, ports.SkillPreparationRequest{
		OrganizationID: intent.OrganizationID, OwnerOperationID: intent.RequestID,
		LayoutVersion: domain.SkillLayoutVersion, SkillSetDigest: intent.TargetSpec.SkillSetDigest,
		SystemSkills: append([]domain.FrozenSkill{}, intent.TargetSpec.SystemSkills...),
	})
	if err != nil {
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: prepare Skill set: %v", ErrDependencyUnavailable, err)
	}
	switch receipt.State {
	case "ready":
		if receipt.PreparedSkillSet == nil || receipt.PreparedSkillSet.SkillSetDigest != intent.TargetSpec.SkillSetDigest || receipt.PreparedSkillSet.LayoutVersion != domain.SkillLayoutVersion || receipt.PreparedReferenceID == "" {
			return ports.SkillPreparationIntent{}, fmt.Errorf("%w: invalid Skill preparation receipt", ErrDependencyUnavailable)
		}
		ready, err := service.skillIntents.MarkSkillPreparationReady(ctx, intent.RequestID, intent.RequestFingerprint, receipt.PreparedReferenceID, service.clock.Now())
		if err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("record Skill preparation: %w", err)
		}
		return ready, nil
	case "rejected":
		if err := service.skillClient.ReleaseSkillPreparation(ctx,
			domain.DeriveResourceID("request", "skill-release-rejected", fmt.Sprintf("%s/%d", intent.RequestID, intent.PreparationAttempt)),
			intent.OrganizationID, intent.AgentID, requestID, intent.RequestID); err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("%w: release rejected Skill preparation: %v", ErrDependencyUnavailable, err)
		}
		if _, err := service.skillIntents.MarkSkillPreparationAbandoned(ctx, intent.RequestID, intent.RequestFingerprint, service.clock.Now()); err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("record rejected Skill preparation: %w", err)
		}
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: Skill preparation rejected: %s", ErrInvalidReference, receipt.ErrorCode)
	case "invalidated":
		if _, err := service.skillIntents.MarkSkillPreparationInvalidated(ctx, intent.RequestID, intent.RequestFingerprint, service.clock.Now()); err != nil {
			return ports.SkillPreparationIntent{}, fmt.Errorf("record invalidated Skill preparation: %w", err)
		}
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: Skill preparation invalidated", ErrDependencyUnavailable)
	default:
		return ports.SkillPreparationIntent{}, fmt.Errorf("%w: Skill preparation %s", ErrDependencyUnavailable, receipt.State)
	}
}

func (service *LifecycleService) attachPreparedSkills(ctx context.Context, operationID, agentID, organizationID string, snapshot domain.AgentSpecSnapshot, configuration *ports.RuntimeConfiguration) error {
	if service.skillIntents == nil {
		return fmt.Errorf("%w: Skill preparation intent is unavailable", ErrDependencyUnavailable)
	}
	intent, err := service.skillIntents.GetSkillPreparationIntent(ctx, operationID)
	if err != nil {
		return fmt.Errorf("%w: load Skill preparation: %v", ErrDependencyUnavailable, err)
	}
	if intent.AgentID != agentID || intent.OrganizationID != organizationID || intent.State != "ready" ||
		intent.PreparedReferenceID == "" || intent.TargetSpec.SkillSetDigest != snapshot.SkillSetDigest {
		return fmt.Errorf("%w: Skill preparation does not match Runtime configuration", ErrDependencyUnavailable)
	}
	configuration.OrganizationID = organizationID
	configuration.SystemSkills = append([]domain.FrozenSkill{}, snapshot.SystemSkills...)
	configuration.PreparedSkillSet = &ports.PreparedSkillSet{SkillSetDigest: snapshot.SkillSetDigest, LayoutVersion: domain.SkillLayoutVersion}
	configuration.PreparedReferenceID = intent.PreparedReferenceID
	return nil
}

func (service *LifecycleService) releasePreparedSkills(ctx context.Context, operationID, fingerprint string) error {
	if service.skillIntents == nil {
		return nil
	}
	intent, err := service.skillIntents.GetSkillPreparationIntent(ctx, operationID)
	if errors.Is(err, ports.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: load Skill preparation release: %v", ErrDependencyUnavailable, err)
	}
	if intent.RequestFingerprint != fingerprint {
		return ports.ErrRequestConflict
	}
	if intent.State == "released" {
		return nil
	}
	if intent.State != "ready" || service.skillClient == nil {
		return fmt.Errorf("%w: Skill preparation reference is not ready to release", ErrDependencyUnavailable)
	}
	preparationID := skillPreparationRequestID(operationID, intent.PreparationAttempt)
	releaseID := domain.DeriveResourceID("request", "skill-release", operationID)
	if err := service.skillClient.ReleaseSkillPreparation(ctx, releaseID, intent.OrganizationID, intent.AgentID, preparationID, operationID); err != nil {
		return fmt.Errorf("%w: release Skill preparation: %v", ErrDependencyUnavailable, err)
	}
	if _, err := service.skillIntents.MarkSkillPreparationReleased(ctx, operationID, fingerprint, service.clock.Now()); err != nil {
		return fmt.Errorf("record Skill preparation release: %w", err)
	}
	return nil
}
