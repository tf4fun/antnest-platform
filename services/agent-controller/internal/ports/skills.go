package ports

import (
	"context"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var ErrSkillNotFound = errors.New("skill version not found")

// SkillVersionResolver returns Registry-owned immutable metadata for exact versions.
type SkillVersionResolver interface {
	Resolve(context.Context, string, []domain.SkillReference) ([]domain.FrozenSkill, error)
}

type PreparedSkillSet struct {
	SkillSetDigest string `json:"skill_set_digest"`
	LayoutVersion  uint32 `json:"layout_version"`
}

type SkillPreparationRequest struct {
	OrganizationID   string               `json:"organization_id"`
	OwnerOperationID string               `json:"owner_operation_id"`
	LayoutVersion    uint32               `json:"layout_version"`
	SkillSetDigest   string               `json:"skill_set_digest"`
	SystemSkills     []domain.FrozenSkill `json:"system_skills"`
}

type SkillPreparationProgress struct {
	VerifiedPackages int   `json:"verified_packages"`
	VerifiedBytes    int64 `json:"verified_bytes"`
	TotalPackages    int   `json:"total_packages"`
	TotalBytes       int64 `json:"total_bytes"`
}

type SkillPreparationReceipt struct {
	RequestID           string                   `json:"request_id"`
	AgentID             string                   `json:"agent_id"`
	OrganizationID      string                   `json:"organization_id"`
	OwnerOperationID    string                   `json:"owner_operation_id"`
	State               string                   `json:"state"`
	Progress            SkillPreparationProgress `json:"progress"`
	PreparedSkillSet    *PreparedSkillSet        `json:"prepared_skill_set,omitempty"`
	PreparedReferenceID string                   `json:"prepared_reference_id,omitempty"`
	RetryAfter          *time.Time               `json:"retry_after,omitempty"`
	ErrorCode           string                   `json:"error_code,omitempty"`
}

type SkillPreparationClient interface {
	PrepareSkillSet(context.Context, string, string, SkillPreparationRequest) (SkillPreparationReceipt, error)
	GetSkillPreparation(context.Context, string, string, string) (SkillPreparationReceipt, error)
	ReleaseSkillPreparation(context.Context, string, string, string, string, string) error
}

// SkillPreparationIntent freezes the target before an Agent lifecycle transition.
// Rebuild and enable source fields are checked again when the transition begins.
type SkillPreparationIntent struct {
	RequestID                   string
	RequestFingerprint          string
	Kind                        domain.OperationKind
	AgentID                     string
	OrganizationID              string
	TargetSpec                  domain.AgentSpecSnapshot
	TargetSpecDigest            string
	ExpectedAggregateSequence   int64
	ExpectedSpecRevisionID      string
	ExpectedExecutionRevisionID string
	ExpectedRuntimeRevision     string
	State                       string
	PreparationAttempt          uint32
	PreparedReferenceID         string
	CreatedAt                   time.Time
	UpdatedAt                   time.Time
}

type SkillPreparationIntentStore interface {
	ReserveSkillPreparation(context.Context, SkillPreparationIntent) (SkillPreparationIntent, error)
	GetSkillPreparationIntent(context.Context, string) (SkillPreparationIntent, error)
	MarkSkillPreparationReady(context.Context, string, string, string, time.Time) (SkillPreparationIntent, error)
	MarkSkillPreparationReleased(context.Context, string, string, time.Time) (SkillPreparationIntent, error)
	MarkSkillPreparationAbandoned(context.Context, string, string, time.Time) (SkillPreparationIntent, error)
	MarkSkillPreparationInvalidated(context.Context, string, string, time.Time) (SkillPreparationIntent, error)
	AdvanceSkillPreparationAttempt(context.Context, string, string, uint32, time.Time) (SkillPreparationIntent, error)
}
