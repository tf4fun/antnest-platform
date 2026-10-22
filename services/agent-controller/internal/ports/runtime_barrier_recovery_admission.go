package ports

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var ErrInvalidRuntimeBarrierRecovery = errors.New("invalid Runtime barrier recovery")

// RuntimeBarrierRebuildCommand preserves the existing six-field Rebuild intent.
// Recovery facts and policy revisions never alter its lifecycle fingerprint.
type RuntimeBarrierRebuildCommand struct {
	RequestID        string
	OrganizationID   string
	ActorPrincipalID string
	AgentID          string
	TemplateID       string
	TemplateRevision int64
}

type RuntimeBarrierRecoveryIntent struct {
	// Manual is supplied only by the authenticated recovery application path.
	// It is not a client field and never changes the lifecycle fingerprint.
	Manual                             bool
	Fact                               RuntimeBarrierResult
	ExpectedPolicyRevision             int64
	ExpectedOwnerUserID                string
	ExpectedOwnerAuthorizationSequence int64
	ExpectedIdentityRevocationSequence int64
	Command                            RuntimeBarrierRebuildCommand
}

// RuntimeBarrierRecoveryReceipt is immutable after the admission transaction.
// Starting the original workflow changes only its separate pending-start row.
type RuntimeBarrierRecoveryReceipt struct {
	Manual             bool
	Fact               RuntimeBarrierResult
	Policy             domain.RuntimeBarrierRecoveryPolicy
	Command            RuntimeBarrierRebuildCommand
	RequestFingerprint string
	AcceptedAt         time.Time
	CooldownUntil      time.Time
}

type RuntimeBarrierRecoveryStore interface {
	ReplayRuntimeBarrierRecovery(context.Context, string, string, string) (RuntimeBarrierRecoveryReceipt, bool, error)
	ListPendingRuntimeBarrierRecoveryStarts(context.Context, string, int) ([]RuntimeBarrierRecoveryReceipt, error)
	ConfirmRuntimeBarrierRecoveryStarted(context.Context, string, string) error
}

// ValidRuntimeBarrierRecoveryActor validates persisted origin, not authority.
// The HTTP boundary must authenticate and authorize every manual request first.
func ValidRuntimeBarrierRecoveryActor(actor string, manual bool) bool {
	return domain.ValidRuntimeBarrierPolicyIdentifier(actor) && (manual || actor == "agent-controller")
}

func RuntimeBarrierRecoveryRequestID(organizationID, agentID, barrierID string) (string, error) {
	if !runtimeBarrierIdentity(organizationID) || !runtimeBarrierIdentity(agentID) || !runtimeBarrierIdentity(barrierID) {
		return "", ErrInvalidRuntimeBarrierRecovery
	}
	tuple, err := json.Marshal([3]string{organizationID, agentID, barrierID})
	if err != nil {
		return "", ErrInvalidRuntimeBarrierRecovery
	}
	return domain.DeriveResourceID("rebuild", "runtime-barrier-recovery", string(tuple)), nil
}
