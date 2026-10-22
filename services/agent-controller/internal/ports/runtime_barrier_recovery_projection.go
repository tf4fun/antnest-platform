package ports

import (
	"context"
	"encoding/json"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

// RecordRuntimeBarrierObservation carries the source and observation version
// captured before the external ACP query. It grants no lifecycle authority.
type RecordRuntimeBarrierObservation struct {
	Fact                        RuntimeBarrierResult
	ExpectedAgent               AgentRecord
	ExpectedPolicyRevision      int64
	ExpectedObservationRevision int64
}

type RuntimeBarrierRecoveryProjection struct {
	BarrierID        string     `json:"barrier_id"`
	Reason           string     `json:"reason"`
	RuntimeRevision  string     `json:"runtime_revision"`
	PolicyRevision   int64      `json:"policy_revision"`
	Mode             string     `json:"mode"`
	CooldownMS       int64      `json:"cooldown_ms"`
	RebuildRequestID string     `json:"rebuild_request_id"`
	NotificationID   string     `json:"notification_id"`
	CooldownUntil    *time.Time `json:"cooldown_until"`
}

type RuntimeBarrierObservationStore interface {
	GetRuntimeBarrierObservationRevision(context.Context, string, string) (int64, error)
	RecordRuntimeBarrierObservation(context.Context, RecordRuntimeBarrierObservation) error
}

type RuntimeBarrierProjectionStore interface {
	GetRuntimeBarrierRecoveryProjection(context.Context, AgentRecord) (*RuntimeBarrierRecoveryProjection, error)
}

func (input RecordRuntimeBarrierObservation) Validate() error {
	agent := input.ExpectedAgent
	if !agent.CanObserveRuntime() ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.OrganizationID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.AgentID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.RuntimeRevision) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.OwnerUserID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.AccessRevision) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agent.AgentSpecRevisionID) ||
		agent.OwnerAuthorizationSequence < 0 || agent.IdentityRevocationSequence < 0 ||
		input.ExpectedPolicyRevision < 0 || input.ExpectedPolicyRevision > domain.RuntimeBarrierRecoveryMaxRevision ||
		input.ExpectedObservationRevision < 0 ||
		!input.Fact.Matches(RuntimeBarrierQuery{OrganizationID: agent.OrganizationID,
			AgentID: agent.AgentID, ExpectedRuntimeRevision: agent.RuntimeRevision}) {
		return ErrInvalidRuntimeBarrierRecovery
	}
	return nil
}

func (projection RuntimeBarrierRecoveryProjection) Validate(organizationID, agentID string) error {
	requestID, err := RuntimeBarrierRecoveryRequestID(organizationID, agentID, projection.BarrierID)
	if err != nil || requestID != projection.RebuildRequestID ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(projection.RuntimeRevision) ||
		projection.Reason != ExecutionRuntimeBarrierRequired {
		return ErrInvalidRuntimeBarrierRecovery
	}
	notificationID, err := RuntimeBarrierNotificationID(organizationID, agentID, projection.BarrierID)
	if err != nil || notificationID != projection.NotificationID ||
		(domain.RuntimeBarrierRecoveryPolicy{OrganizationID: organizationID, Revision: projection.PolicyRevision,
			Mode: projection.Mode, CooldownMS: projection.CooldownMS}).Validate() != nil {
		return ErrInvalidRuntimeBarrierRecovery
	}
	if deadline := projection.CooldownUntil; deadline != nil {
		_, offset := deadline.Zone()
		if deadline.IsZero() || deadline.Year() < 1 || deadline.Year() > 9999 || offset != 0 {
			return ErrInvalidRuntimeBarrierRecovery
		}
	}
	return nil
}

func RuntimeBarrierNotificationID(organizationID, agentID, barrierID string) (string, error) {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(organizationID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(agentID) || !runtimeBarrierIdentity(barrierID) {
		return "", ErrInvalidRuntimeBarrierRecovery
	}
	tuple, err := json.Marshal([3]string{organizationID, agentID, barrierID})
	if err != nil {
		return "", ErrInvalidRuntimeBarrierRecovery
	}
	return domain.DeriveResourceID("notification", "runtime-barrier-recovery", string(tuple)), nil
}
