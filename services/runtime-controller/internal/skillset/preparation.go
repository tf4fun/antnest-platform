package skillset

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

type PrepareRequest struct {
	Scope            string        `json:"-"`
	RequestID        string        `json:"-"`
	AgentID          string        `json:"-"`
	OrganizationID   string        `json:"organization_id"`
	OwnerOperationID string        `json:"owner_operation_id"`
	LayoutVersion    uint32        `json:"layout_version"`
	SkillSetDigest   string        `json:"skill_set_digest"`
	SystemSkills     []FrozenSkill `json:"system_skills"`
}

type PreparationState string

const (
	PreparationQueued         PreparationState = "queued"
	PreparationPreparing      PreparationState = "preparing"
	PreparationRetryWait      PreparationState = "retry_wait"
	PreparationPaused         PreparationState = "paused"
	PreparationReady          PreparationState = "ready"
	PreparationRejected       PreparationState = "rejected"
	PreparationInvalidated    PreparationState = "invalidated"
	PreparationCleanupPending PreparationState = "cleanup_pending"
)

type PreparationProgress struct {
	VerifiedPackages int   `json:"verified_packages"`
	VerifiedBytes    int64 `json:"verified_bytes"`
	TotalPackages    int   `json:"total_packages"`
	TotalBytes       int64 `json:"total_bytes"`
}

type PreparedSet struct {
	SkillSetDigest string `json:"skill_set_digest"`
	LayoutVersion  uint32 `json:"layout_version"`
}

// PreparedReference is the exact logical collection and operation-owned
// reference requested by a lifecycle mutation. Physical volume identity stays
// private to Runtime Controller.
type PreparedReference struct {
	Scope          string
	OrganizationID string
	AgentID        string
	SkillSetDigest string
	LayoutVersion  uint32
	ReferenceID    string
	SystemSkills   []FrozenSkill
}

type PreparedMaterialization struct {
	SetID          int64
	Key            SetKey
	VolumeName     string
	ManifestDigest string
}

type PreparationReceipt struct {
	RequestID           string              `json:"request_id"`
	AgentID             string              `json:"agent_id"`
	OrganizationID      string              `json:"organization_id"`
	OwnerOperationID    string              `json:"owner_operation_id"`
	State               PreparationState    `json:"state"`
	Progress            PreparationProgress `json:"progress"`
	PreparedSkillSet    *PreparedSet        `json:"prepared_skill_set,omitempty"`
	PreparedReferenceID string              `json:"prepared_reference_id,omitempty"`
	RetryAfter          *time.Time          `json:"retry_after,omitempty"`
	ErrorCode           string              `json:"error_code,omitempty"`
}

func validControlIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 200 {
		return false
	}
	for i := 0; i < len(value); i++ {
		letter := value[i] >= 'a' && value[i] <= 'z' || value[i] >= 'A' && value[i] <= 'Z'
		digit := value[i] >= '0' && value[i] <= '9'
		if !letter && !digit && (i == 0 || value[i] != '_' && value[i] != '.' && value[i] != '-') {
			return false
		}
	}
	return true
}

func validScope(value string) bool {
	if len(value) == 0 || len(value) > 200 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 33 || value[i] > 126 {
			return false
		}
	}
	return true
}

// ValidateAndDigest binds an idempotency request to the exact frozen input.
// The set digest is independently recomputed before durable admission.
func (r PrepareRequest) ValidateAndDigest() (string, error) {
	if !validControlIdentifier(r.RequestID) || !validControlIdentifier(r.AgentID) ||
		!validControlIdentifier(r.OwnerOperationID) || !validScope(r.Scope) {
		return "", fmt.Errorf("invalid preparation identity")
	}
	actual, err := Digest(r.OrganizationID, r.LayoutVersion, r.SystemSkills)
	if err != nil {
		return "", err
	}
	if r.SkillSetDigest != actual {
		return "", fmt.Errorf("skill set digest does not match frozen input")
	}
	payload, err := json.Marshal(r)
	if err != nil {
		return "", fmt.Errorf("encode preparation request: %w", err)
	}
	// Agent and request identity are in the key but also bound to this receipt.
	hash := sha256.New()
	hash.Write([]byte("antnest-skill-prepare-v1\x00"))
	for _, value := range []string{r.Scope, r.RequestID, r.AgentID} {
		hash.Write([]byte(value))
		hash.Write([]byte{0})
	}
	hash.Write(payload)
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}
