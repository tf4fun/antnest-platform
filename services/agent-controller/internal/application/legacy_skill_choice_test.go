package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type legacyChoiceStoreStub struct {
	record  ports.LegacySkillMigrationRecord
	choices map[string]ports.LegacySkillChoice
	saves   int
}

func (stub *legacyChoiceStoreStub) GetLegacySkillMigration(_ context.Context, organizationID, agentID string) (ports.LegacySkillMigrationRecord, error) {
	if stub.record.OrganizationID != organizationID || stub.record.AgentID != agentID {
		return ports.LegacySkillMigrationRecord{}, ports.ErrNotFound
	}
	return stub.record, nil
}
func (stub *legacyChoiceStoreStub) ReplayLegacySkillChoice(_ context.Context, requestID, fingerprint, organizationID, agentID string) (ports.LegacySkillChoice, bool, error) {
	choice, found := stub.choices[requestID]
	if !found {
		return ports.LegacySkillChoice{}, false, nil
	}
	if choice.Fingerprint != fingerprint || choice.AgentID != agentID || choice.OrganizationID != organizationID {
		return ports.LegacySkillChoice{}, false, ports.ErrRequestConflict
	}
	return choice, true, nil
}
func (stub *legacyChoiceStoreStub) RecordLegacySkillChoice(_ context.Context, choice ports.LegacySkillChoice) (ports.LegacySkillChoice, error) {
	stub.saves++
	choice.Sequence = int64(stub.saves)
	stub.choices[choice.RequestID] = choice
	return choice, nil
}

type legacyInventoryStub struct {
	inventory ports.LegacySkillInventory
	err       error
	calls     int
}

type legacyBackupReceiptStub struct {
	receipt ports.LegacySkillBackupReceipt
	err     error
	calls   int
}

func (stub *legacyBackupReceiptStub) GetLegacySkillBackup(_ context.Context, backupRef string) (ports.LegacySkillBackupReceipt, error) {
	stub.calls++
	if stub.receipt.BackupRef != backupRef && stub.err == nil {
		return ports.LegacySkillBackupReceipt{}, errors.New("unexpected backup reference")
	}
	return stub.receipt, stub.err
}

func validLegacyBackupReceipt() ports.LegacySkillBackupReceipt {
	input := validLegacyChoiceInput()
	return ports.LegacySkillBackupReceipt{BackupRef: input.BackupRef, VolumeName: input.VolumeName, InventoryDigest: input.InventoryDigest, ManifestDigest: input.BackupDigest}
}

func (stub *legacyInventoryStub) GetLegacySkillInventory(context.Context) (ports.LegacySkillInventory, error) {
	stub.calls++
	return stub.inventory, stub.err
}

type legacyTemplateStub struct {
	view  TemplateView
	calls int
}

func (stub *legacyTemplateStub) GetTemplateRevision(_ context.Context, _, _ string, _ int64) (TemplateView, error) {
	stub.calls++
	return stub.view, nil
}

func TestLegacyChoiceRejectsInventoryChangeWithoutRecording(t *testing.T) {
	store := &legacyChoiceStoreStub{record: ports.LegacySkillMigrationRecord{AgentID: "agent-1", OrganizationID: "org-1", State: "pending"}, choices: map[string]ports.LegacySkillChoice{}}
	inventory := &legacyInventoryStub{inventory: ports.LegacySkillInventory{VolumeName: "legacy", InventoryDigest: "sha256:" + strings.Repeat("a", 64), Entries: []ports.LegacySkillInventoryEntry{}, References: []ports.LegacySkillInventoryReference{}}}
	backup := &legacyBackupReceiptStub{receipt: validLegacyBackupReceipt()}
	service := NewLegacySkillMigrationService(store, inventory, backup, &legacyTemplateStub{}, fixedClock{now: time.Unix(100, 0).UTC()})
	input := validLegacyChoiceInput()
	input.InventoryDigest = "sha256:" + strings.Repeat("b", 64)
	if _, err := service.RecordLegacySkillChoice(context.Background(), input); !errors.Is(err, ErrLegacyInventoryChanged) || store.saves != 0 {
		t.Fatalf("changed inventory recorded: %v, saves=%d", err, store.saves)
	}
	if _, err := service.GetLegacySkillMigration(context.Background(), "foreign-org", "agent-1"); !errors.Is(err, ErrAgentNotFound) || inventory.calls != 1 {
		t.Fatalf("foreign inventory exposed: %v calls=%d", err, inventory.calls)
	}
}

func TestLegacyChoiceReplaysWithoutInventoryAndChecksFixedTemplate(t *testing.T) {
	store := &legacyChoiceStoreStub{record: ports.LegacySkillMigrationRecord{AgentID: "agent-1", OrganizationID: "org-1", State: "pending"}, choices: map[string]ports.LegacySkillChoice{}}
	inventory := &legacyInventoryStub{inventory: ports.LegacySkillInventory{VolumeName: "legacy", InventoryDigest: "sha256:" + strings.Repeat("a", 64), Entries: []ports.LegacySkillInventoryEntry{}, References: []ports.LegacySkillInventoryReference{}}}
	templates := &legacyTemplateStub{view: TemplateView{TemplateID: "template-1", OrganizationID: "org-1", Revision: 2, SkillRefs: []domain.FrozenSkill{{SkillID: "skill_11111111111111111111111111111111"}}}}
	backup := &legacyBackupReceiptStub{receipt: validLegacyBackupReceipt()}
	service := NewLegacySkillMigrationService(store, inventory, backup, templates, fixedClock{now: time.Unix(100, 0).UTC()})
	input := validLegacyChoiceInput()
	input.Kind, input.TemplateID, input.TemplateRevision = "template_revision", "template-1", 2
	choice, err := service.RecordLegacySkillChoice(context.Background(), input)
	if err != nil || choice.Kind != "template_revision" || store.saves != 1 || templates.calls != 1 || backup.calls != 1 {
		t.Fatalf("fixed template choice=%+v, %v", choice, err)
	}
	inventory.err = errors.New("Registry unavailable")
	replayed, err := service.RecordLegacySkillChoice(context.Background(), input)
	if err != nil || replayed.RequestID != choice.RequestID || inventory.calls != 1 || backup.calls != 1 || store.saves != 1 {
		t.Fatalf("replay depended on live inventory: %+v, %v", replayed, err)
	}
	input.BackupRef = "changed"
	if _, err := service.RecordLegacySkillChoice(context.Background(), input); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("conflicting choice replay=%v", err)
	}
}

func TestLegacyChoiceRequiresMatchingVerifiedRCBackup(t *testing.T) {
	for _, change := range []struct {
		name string
		edit func(*legacyBackupReceiptStub)
		want error
	}{
		{"missing", func(stub *legacyBackupReceiptStub) {
			stub.err = &ports.DependencyError{Service: "runtime-controller", Code: "legacy_backup_not_found"}
		}, ErrLegacyBackupMismatch},
		{"digest", func(stub *legacyBackupReceiptStub) { stub.receipt.ManifestDigest = "sha256:" + strings.Repeat("c", 64) }, ErrLegacyBackupMismatch},
		{"volume", func(stub *legacyBackupReceiptStub) { stub.receipt.VolumeName = "other" }, ErrLegacyBackupMismatch},
		{"inventory", func(stub *legacyBackupReceiptStub) {
			stub.receipt.InventoryDigest = "sha256:" + strings.Repeat("c", 64)
		}, ErrLegacyBackupMismatch},
		{"unavailable", func(stub *legacyBackupReceiptStub) { stub.err = errors.New("offline") }, ErrDependencyUnavailable},
	} {
		t.Run(change.name, func(t *testing.T) {
			store := &legacyChoiceStoreStub{record: ports.LegacySkillMigrationRecord{AgentID: "agent-1", OrganizationID: "org-1", State: "pending"}, choices: map[string]ports.LegacySkillChoice{}}
			inventory := &legacyInventoryStub{inventory: ports.LegacySkillInventory{VolumeName: "legacy", InventoryDigest: "sha256:" + strings.Repeat("a", 64), Entries: []ports.LegacySkillInventoryEntry{}, References: []ports.LegacySkillInventoryReference{}}}
			backup := &legacyBackupReceiptStub{receipt: validLegacyBackupReceipt()}
			change.edit(backup)
			service := NewLegacySkillMigrationService(store, inventory, backup, &legacyTemplateStub{}, fixedClock{now: time.Unix(100, 0).UTC()})
			if _, err := service.RecordLegacySkillChoice(context.Background(), validLegacyChoiceInput()); !errors.Is(err, change.want) || store.saves != 0 || backup.calls != 1 {
				t.Fatalf("unverified choice recorded: err=%v saves=%d backup calls=%d", err, store.saves, backup.calls)
			}
		})
	}
}

func validLegacyChoiceInput() RecordLegacySkillChoiceInput {
	return RecordLegacySkillChoiceInput{RequestID: "choice-1", OrganizationID: "org-1", AgentID: "agent-1", ActorPrincipalID: "admin-1", Kind: "empty",
		VolumeName: "legacy", InventoryDigest: "sha256:" + strings.Repeat("a", 64), BackupRef: "backup-1", BackupDigest: "sha256:" + strings.Repeat("b", 64)}
}
