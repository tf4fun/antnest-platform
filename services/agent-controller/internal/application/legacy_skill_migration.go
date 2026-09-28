package application

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrLegacyInventoryChanged = errors.New("legacy system Skill inventory changed")
var ErrLegacyBackupMismatch = errors.New("legacy system Skill backup does not match choice")
var skillDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var legacyBackupRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type LegacyTemplateSource interface {
	GetTemplateRevision(context.Context, string, string, int64) (TemplateView, error)
}

type LegacySkillMigrationService struct {
	store          ports.LegacySkillMigrationStore
	inventory      ports.LegacySkillInventoryClient
	backup         ports.LegacySkillBackupClient
	templates      LegacyTemplateSource
	clock          ports.Clock
	verifierKeys   map[string]ed25519.PublicKey
	verifierStatus LegacyVerifierKeyStatus
}

type LegacyVerifierKeyStatus interface {
	LegacyVerifierKeyActive(context.Context, string, ed25519.PublicKey) (bool, error)
}

type LegacySkillMigrationOption func(*LegacySkillMigrationService)

func WithLegacyExportVerifierTrust(keys map[string]ed25519.PublicKey, status LegacyVerifierKeyStatus) LegacySkillMigrationOption {
	return func(service *LegacySkillMigrationService) {
		service.verifierKeys = make(map[string]ed25519.PublicKey, len(keys))
		for id, key := range keys {
			service.verifierKeys[id] = append(ed25519.PublicKey(nil), key...)
		}
		service.verifierStatus = status
	}
}

func NewLegacySkillMigrationService(store ports.LegacySkillMigrationStore, inventory ports.LegacySkillInventoryClient, backup ports.LegacySkillBackupClient, templates LegacyTemplateSource, clock ports.Clock, options ...LegacySkillMigrationOption) *LegacySkillMigrationService {
	service := &LegacySkillMigrationService{store: store, inventory: inventory, backup: backup, templates: templates, clock: clock}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service
}

type LegacySkillMigrationReview struct {
	Migration ports.LegacySkillMigrationRecord `json:"migration"`
	Inventory ports.LegacySkillInventory       `json:"inventory"`
}

func (service *LegacySkillMigrationService) GetLegacySkillMigration(ctx context.Context, organizationID, agentID string) (LegacySkillMigrationReview, error) {
	if !validIdentifier(organizationID) || !validIdentifier(agentID) {
		return LegacySkillMigrationReview{}, ErrInvalidInput
	}
	record, err := service.store.GetLegacySkillMigration(ctx, organizationID, agentID)
	if errors.Is(err, ports.ErrNotFound) {
		return LegacySkillMigrationReview{}, ErrAgentNotFound
	}
	if err != nil {
		return LegacySkillMigrationReview{}, fmt.Errorf("read legacy Skill migration: %w", err)
	}
	inventory, err := service.inventory.GetLegacySkillInventory(ctx)
	if err != nil {
		return LegacySkillMigrationReview{}, fmt.Errorf("%w: read legacy Skill inventory: %v", ErrDependencyUnavailable, err)
	}
	return LegacySkillMigrationReview{Migration: record, Inventory: inventory}, nil
}

type RecordLegacySkillChoiceInput struct {
	RequestID        string `json:"-"`
	OrganizationID   string `json:"organization_id"`
	AgentID          string `json:"-"`
	ActorPrincipalID string `json:"actor_principal_id"`
	Kind             string `json:"kind"`
	VolumeName       string `json:"volume_name"`
	InventoryDigest  string `json:"inventory_digest"`
	BackupRef        string `json:"backup_ref"`
	BackupDigest     string `json:"backup_digest"`
	TemplateID       string `json:"template_id,omitempty"`
	TemplateRevision int64  `json:"template_revision,omitempty"`
}

func (service *LegacySkillMigrationService) RecordLegacySkillChoice(ctx context.Context, input RecordLegacySkillChoiceInput) (ports.LegacySkillChoice, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) || !validIdentifier(input.AgentID) || !validIdentifier(input.ActorPrincipalID) ||
		len(input.VolumeName) == 0 || len(input.VolumeName) > 255 || strings.ContainsAny(input.VolumeName, "/\\\x00") ||
		!skillDigestPattern.MatchString(input.InventoryDigest) || !skillDigestPattern.MatchString(input.BackupDigest) ||
		!legacyBackupRefPattern.MatchString(input.BackupRef) ||
		input.Kind != "empty" && input.Kind != "template_revision" ||
		input.Kind == "empty" && (input.TemplateID != "" || input.TemplateRevision != 0) ||
		input.Kind == "template_revision" && (!validIdentifier(input.TemplateID) || input.TemplateRevision < 1) {
		return ports.LegacySkillChoice{}, ErrInvalidInput
	}
	record, err := service.store.GetLegacySkillMigration(ctx, input.OrganizationID, input.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySkillChoice{}, ErrAgentNotFound
	}
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("read legacy Skill migration: %w", err)
	}
	fingerprint, err := requestFingerprint(input)
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	replayed, found, err := service.store.ReplayLegacySkillChoice(ctx, input.RequestID, fingerprint, input.OrganizationID, input.AgentID)
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	if found {
		return replayed, nil
	}
	if record.State != "pending" {
		return ports.LegacySkillChoice{}, ErrLifecycleConflict
	}
	inventory, err := service.inventory.GetLegacySkillInventory(ctx)
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("%w: read legacy Skill inventory: %v", ErrDependencyUnavailable, err)
	}
	if inventory.VolumeName != input.VolumeName || inventory.InventoryDigest != input.InventoryDigest {
		return ports.LegacySkillChoice{}, ErrLegacyInventoryChanged
	}
	receipt, err := service.backup.GetLegacySkillBackup(ctx, input.BackupRef)
	if err != nil {
		var dependency *ports.DependencyError
		if errors.As(err, &dependency) && dependency.Code == "legacy_backup_not_found" {
			return ports.LegacySkillChoice{}, ErrLegacyBackupMismatch
		}
		return ports.LegacySkillChoice{}, fmt.Errorf("%w: verify legacy Skill backup: %v", ErrDependencyUnavailable, err)
	}
	if receipt.BackupRef != input.BackupRef || receipt.VolumeName != input.VolumeName ||
		receipt.InventoryDigest != input.InventoryDigest || receipt.ManifestDigest != input.BackupDigest {
		return ports.LegacySkillChoice{}, ErrLegacyBackupMismatch
	}
	if input.Kind == "template_revision" {
		template, err := service.templates.GetTemplateRevision(ctx, input.OrganizationID, input.TemplateID, input.TemplateRevision)
		if err != nil {
			return ports.LegacySkillChoice{}, err
		}
		if template.OrganizationID != input.OrganizationID || template.TemplateID != input.TemplateID || template.Revision != input.TemplateRevision || len(template.SkillRefs) == 0 {
			return ports.LegacySkillChoice{}, ErrInvalidReference
		}
	}
	choice := ports.LegacySkillChoice{
		RequestID: input.RequestID, Fingerprint: fingerprint, AgentID: input.AgentID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, Kind: input.Kind, VolumeName: input.VolumeName,
		InventoryDigest: input.InventoryDigest, BackupRef: input.BackupRef, BackupDigest: input.BackupDigest,
		TemplateID: input.TemplateID, TemplateRevision: input.TemplateRevision, CreatedAt: service.clock.Now(),
	}
	choice, err = service.store.RecordLegacySkillChoice(ctx, choice)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.LegacySkillChoice{}, ErrAgentNotFound
	}
	if errors.Is(err, ports.ErrConcurrentChange) {
		return ports.LegacySkillChoice{}, ErrLifecycleConflict
	}
	if err != nil {
		return ports.LegacySkillChoice{}, fmt.Errorf("record legacy Skill choice: %w", err)
	}
	return choice, nil
}
