package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// LegacySkillMigrationOperationInput has a distinct command identity from an
// ordinary Rebuild, even though an enabled Agent follows the Rebuild phases.
type LegacySkillMigrationOperationInput struct {
	RequestID        string                  `json:"-"`
	OrganizationID   string                  `json:"organization_id"`
	ActorPrincipalID string                  `json:"actor_principal_id"`
	AgentID          string                  `json:"-"`
	ChoiceSequence   int64                   `json:"choice_sequence"`
	Attestation      LegacyExportAttestation `json:"attestation"`
}

func (service *LifecycleService) MigrateLegacySkills(ctx context.Context, input LegacySkillMigrationOperationInput) (RebuildAgentResult, error) {
	kind, err := service.MigrationOperationKind(ctx, input.RequestID, input.AgentID)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	if kind == domain.OperationEnable {
		result, err := service.migrateDisabledLegacySkills(ctx, input)
		return RebuildAgentResult(result), err
	}
	return service.rebuildAgent(ctx, RebuildAgentInput{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID, migration: &input,
	})
}

func (service *LifecycleService) MigrationOperationKind(ctx context.Context, requestID, agentID string) (domain.OperationKind, error) {
	if !validIdentifier(requestID) || !validIdentifier(agentID) {
		return "", ErrInvalidInput
	}
	operation, err := service.store.GetLifecycleOperation(ctx, requestID)
	if err == nil && operation.Kind != "" {
		if operation.Kind != domain.OperationRebuild && operation.Kind != domain.OperationEnable {
			return "", ports.ErrRequestConflict
		}
		return operation.Kind, nil
	}
	if err != nil && !errors.Is(err, ports.ErrNotFound) {
		return "", err
	}
	base, err := service.store.GetAgentEnableBase(ctx, agentID)
	if err != nil {
		return "", err
	}
	if base.Agent.DesiredState == domain.DesiredDisabled {
		return domain.OperationEnable, nil
	}
	return domain.OperationRebuild, nil
}

func (service *LifecycleService) preflightLegacyMigration(ctx context.Context, organizationID, agentID string,
	input *LegacySkillMigrationOperationInput) (ports.LegacySkillChoice, error) {
	if service.legacyMigrationPreflight == nil {
		return ports.LegacySkillChoice{}, ErrDependencyUnavailable
	}
	choice, err := service.legacyMigrationPreflight.VerifyLegacySkillMigrationPrerequisites(ctx, organizationID, agentID,
		input.ChoiceSequence, input.Attestation)
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	if choice.AgentID != agentID || choice.OrganizationID != organizationID || choice.Sequence != input.ChoiceSequence ||
		(choice.Kind != "empty" && choice.Kind != "template_revision") {
		return ports.LegacySkillChoice{}, ErrLifecycleConflict
	}
	return choice, nil
}

func emptyLegacyMigrationTarget(organizationID string, source domain.AgentSpecSnapshot) (domain.AgentSpecSnapshot, string, error) {
	target := source
	target.SystemSkills = []domain.FrozenSkill{}
	var err error
	target.SkillSetDigest, err = domain.SkillSetDigest(organizationID, target.SystemSkills)
	if err != nil {
		return domain.AgentSpecSnapshot{}, "", err
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return domain.AgentSpecSnapshot{}, "", fmt.Errorf("encode empty legacy migration target: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return target, hex.EncodeToString(digest[:]), nil
}

func validateLegacyMigrationTarget(organizationID string, source, target domain.AgentSpecSnapshot, choice ports.LegacySkillChoice) error {
	switch choice.Kind {
	case "empty":
		expected, _, err := emptyLegacyMigrationTarget(organizationID, source)
		if err != nil {
			return err
		}
		expected.SystemSkills, target.SystemSkills = nil, nil
		if !reflect.DeepEqual(expected, target) {
			return ErrInvalidReference
		}
	case "template_revision":
		if target.TemplateID != choice.TemplateID || target.TemplateRevision != choice.TemplateRevision || len(target.SystemSkills) == 0 {
			return ErrInvalidReference
		}
	default:
		return ErrInvalidReference
	}
	return nil
}

func legacyMigrationBinding(choice ports.LegacySkillChoice, proof LegacyExportAttestation) (ports.LegacySkillMigrationBinding, error) {
	encoded, err := json.Marshal(proof)
	if err != nil {
		return ports.LegacySkillMigrationBinding{}, fmt.Errorf("encode legacy Skill proof: %w", err)
	}
	expires, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
	if err != nil {
		return ports.LegacySkillMigrationBinding{}, fmt.Errorf("%w: legacy Skill proof expiry", ErrInvalidInput)
	}
	digest := sha256.Sum256(encoded)
	return ports.LegacySkillMigrationBinding{
		ChoiceRequestID: choice.RequestID, ChoiceSequence: choice.Sequence,
		KeyID: proof.KeyID, Attestation: encoded, AttestationDigest: hex.EncodeToString(digest[:]), ExpiresAt: expires,
	}, nil
}
