package application

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type verifierKeyStatusStub struct {
	active bool
	calls  int
}

func (stub *verifierKeyStatusStub) LegacyVerifierKeyActive(context.Context, string, ed25519.PublicKey) (bool, error) {
	stub.calls++
	return stub.active, nil
}

func TestLegacyMigrationPreflightRequiresCurrentChoiceBackupAndActiveSigningKey(t *testing.T) {
	now := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	choiceInput := validLegacyChoiceInput()
	choice := ports.LegacySkillChoice{AgentID: choiceInput.AgentID, OrganizationID: choiceInput.OrganizationID,
		Sequence: 2, Kind: choiceInput.Kind, VolumeName: choiceInput.VolumeName,
		InventoryDigest: choiceInput.InventoryDigest, BackupRef: choiceInput.BackupRef, BackupDigest: choiceInput.BackupDigest}
	store := &legacyChoiceStoreStub{record: ports.LegacySkillMigrationRecord{AgentID: "agent-1", OrganizationID: "org-1", State: "pending", LatestChoice: &choice}}
	inventory := &legacyInventoryStub{inventory: ports.LegacySkillInventory{VolumeName: choice.VolumeName, InventoryDigest: choice.InventoryDigest}}
	backup := &legacyBackupReceiptStub{receipt: validLegacyBackupReceipt()}
	backup.receipt.ArchiveDigest = "sha256:" + strings.Repeat("c", 64)
	status := &verifierKeyStatusStub{active: true}
	proof := LegacyExportAttestation{Version: 1, KeyID: "verifier-key", VerifierID: "verifier-host",
		StorageRef: "s3://backups.example/legacy/backup-1", BackupRef: choice.BackupRef,
		VolumeName: choice.VolumeName, InventoryDigest: choice.InventoryDigest,
		ArchiveDigest: backup.receipt.ArchiveDigest, ManifestDigest: choice.BackupDigest,
		VerifiedAt: now.Add(-time.Minute).Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano)}
	proof.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, legacyExportAttestationMessage(proof)))
	service := NewLegacySkillMigrationService(store, inventory, backup, &legacyTemplateStub{}, fixedClock{now: now},
		WithLegacyExportVerifierTrust(map[string]ed25519.PublicKey{"verifier-key": private.Public().(ed25519.PublicKey)}, status))
	got, err := service.VerifyLegacySkillMigrationPrerequisites(context.Background(), "org-1", "agent-1", 2, proof)
	if err != nil || got.Sequence != 2 || inventory.calls != 1 || backup.calls != 1 || status.calls != 1 {
		t.Fatalf("valid preflight choice=%+v err=%v calls=%d/%d/%d", got, err, inventory.calls, backup.calls, status.calls)
	}
	if _, err := service.VerifyLegacySkillMigrationPrerequisites(context.Background(), "org-1", "agent-1", 1, proof); !errors.Is(err, ErrLifecycleConflict) || inventory.calls != 1 {
		t.Fatalf("stale choice admitted: %v", err)
	}
	inventory.inventory.InventoryDigest = "sha256:" + strings.Repeat("d", 64)
	if _, err := service.VerifyLegacySkillMigrationPrerequisites(context.Background(), "org-1", "agent-1", 2, proof); !errors.Is(err, ErrLegacyInventoryChanged) {
		t.Fatalf("changed inventory admitted: %v", err)
	}
	inventory.inventory.InventoryDigest = choice.InventoryDigest
	status.active = false
	if _, err := service.VerifyLegacySkillMigrationPrerequisites(context.Background(), "org-1", "agent-1", 2, proof); !errors.Is(err, ErrLegacyAttestationInvalid) {
		t.Fatalf("revoked key admitted: %v", err)
	}
	status.active = true
	backup.receipt.ArchiveDigest = "sha256:" + strings.Repeat("d", 64)
	if _, err := service.VerifyLegacySkillMigrationPrerequisites(context.Background(), "org-1", "agent-1", 2, proof); !errors.Is(err, ErrLegacyAttestationInvalid) {
		t.Fatalf("changed backup admitted: %v", err)
	}
}
