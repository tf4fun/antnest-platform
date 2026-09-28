package application

import (
	"context"
	"errors"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// VerifyLegacySkillMigrationPrerequisites is an admission check, not a durable
// grant. The migration transaction must compare the same latest choice under
// lock, and publish must recheck the key and actual Runtime target.
func (service *LegacySkillMigrationService) VerifyLegacySkillMigrationPrerequisites(ctx context.Context, organizationID, agentID string, expectedSequence int64, proof LegacyExportAttestation) (ports.LegacySkillChoice, error) {
	if !validIdentifier(organizationID) || !validIdentifier(agentID) || expectedSequence < 1 {
		return ports.LegacySkillChoice{}, ErrInvalidInput
	}
	if len(service.verifierKeys) == 0 || service.verifierStatus == nil {
		return ports.LegacySkillChoice{}, ErrDependencyUnavailable
	}
	record, err := service.store.GetLegacySkillMigration(ctx, organizationID, agentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySkillChoice{}, ErrAgentNotFound
	}
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("read legacy Skill migration: %w", err)
	}
	if record.State != "pending" || record.LatestChoice == nil || record.LatestChoice.Sequence != expectedSequence {
		return ports.LegacySkillChoice{}, ErrLifecycleConflict
	}
	choice := *record.LatestChoice
	inventory, err := service.inventory.GetLegacySkillInventory(ctx)
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("%w: read legacy Skill inventory: %v", ErrDependencyUnavailable, err)
	}
	if inventory.VolumeName != choice.VolumeName || inventory.InventoryDigest != choice.InventoryDigest {
		return ports.LegacySkillChoice{}, ErrLegacyInventoryChanged
	}
	receipt, err := service.backup.GetLegacySkillBackup(ctx, choice.BackupRef)
	if err != nil {
		var dependency *ports.DependencyError
		if errors.As(err, &dependency) && dependency.Code == "legacy_backup_not_found" {
			return ports.LegacySkillChoice{}, ErrLegacyBackupMismatch
		}
		return ports.LegacySkillChoice{}, fmt.Errorf("%w: verify legacy Skill backup: %v", ErrDependencyUnavailable, err)
	}
	key := service.verifierKeys[proof.KeyID]
	if len(key) == 0 {
		return ports.LegacySkillChoice{}, ErrLegacyAttestationInvalid
	}
	active, err := service.verifierStatus.LegacyVerifierKeyActive(ctx, proof.KeyID, key)
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("%w: check legacy verifier key: %v", ErrDependencyUnavailable, err)
	}
	if !active {
		return ports.LegacySkillChoice{}, ErrLegacyAttestationInvalid
	}
	if err := VerifyLegacyExportAttestation(proof, service.verifierKeys, choice, receipt, service.clock.Now()); err != nil {
		return ports.LegacySkillChoice{}, err
	}
	return choice, nil
}
