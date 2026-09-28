package ports

import (
	"context"
	"time"
)

type LegacySkillChoice struct {
	RequestID        string    `json:"request_id"`
	Fingerprint      string    `json:"-"`
	AgentID          string    `json:"agent_id"`
	OrganizationID   string    `json:"organization_id"`
	ActorPrincipalID string    `json:"actor_principal_id"`
	Sequence         int64     `json:"sequence"`
	Kind             string    `json:"kind"`
	VolumeName       string    `json:"volume_name"`
	InventoryDigest  string    `json:"inventory_digest"`
	BackupRef        string    `json:"backup_ref"`
	BackupDigest     string    `json:"backup_digest"`
	TemplateID       string    `json:"template_id,omitempty"`
	TemplateRevision int64     `json:"template_revision,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
}

type LegacySkillMigrationRecord struct {
	AgentID        string             `json:"agent_id"`
	OrganizationID string             `json:"organization_id"`
	State          string             `json:"state"`
	LatestChoice   *LegacySkillChoice `json:"latest_choice,omitempty"`
}

type LegacySkillInventoryEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size"`
	Digest string `json:"digest,omitempty"`
}

type LegacySkillInventoryReference struct {
	ContainerID string `json:"container_id"`
	AgentID     string `json:"agent_id,omitempty"`
	Running     bool   `json:"running"`
	Managed     bool   `json:"managed"`
}

type LegacySkillInventory struct {
	VolumeName      string                          `json:"volume_name"`
	InventoryDigest string                          `json:"inventory_digest"`
	Entries         []LegacySkillInventoryEntry     `json:"entries"`
	References      []LegacySkillInventoryReference `json:"references"`
}

type LegacySkillInventoryClient interface {
	GetLegacySkillInventory(context.Context) (LegacySkillInventory, error)
}

type LegacySkillBackupReceipt struct {
	BackupRef       string                      `json:"backup_ref"`
	VolumeName      string                      `json:"volume_name"`
	InventoryDigest string                      `json:"inventory_digest"`
	Entries         []LegacySkillInventoryEntry `json:"entries"`
	ArchiveDigest   string                      `json:"archive_digest"`
	ManifestDigest  string                      `json:"manifest_digest"`
	CreatedAt       time.Time                   `json:"created_at"`
}

type LegacySkillBackupClient interface {
	GetLegacySkillBackup(context.Context, string) (LegacySkillBackupReceipt, error)
}

type LegacySkillMigrationStore interface {
	GetLegacySkillMigration(context.Context, string, string) (LegacySkillMigrationRecord, error)
	ReplayLegacySkillChoice(context.Context, string, string, string, string) (LegacySkillChoice, bool, error)
	RecordLegacySkillChoice(context.Context, LegacySkillChoice) (LegacySkillChoice, error)
}
