package ports

import "time"

// AgentReadinessEvidence is private repository evidence, never an execution
// prerequisite or a wire payload. Nil evidence means a legacy/unknown view.
type AgentReadinessEvidence struct {
	Access                  AgentAccessRecord
	OwnerRevocationSequence int64
	CommittedRevision       int64
	AppliedRevision         int64
	Binding                 *RuntimeReadinessProof
}

type RuntimeReadinessProof struct {
	AgentID                    string     `json:"agent_id"`
	OrganizationID             string     `json:"organization_id"`
	ExecutionRevisionID        string     `json:"execution_revision_id"`
	AgentSpecRevisionID        string     `json:"agent_spec_revision_id"`
	RuntimeRevision            string     `json:"runtime_revision"`
	RuntimeExecutionID         string     `json:"runtime_execution_id"`
	OwnerUserID                string     `json:"owner_user_id"`
	AccessRevision             string     `json:"access_revision"`
	OwnerAuthorizationSequence int64      `json:"owner_authorization_sequence"`
	ReadyAfterRevision         int64      `json:"ready_after_revision"`
	ReopenAfterRevision        int64      `json:"reopen_after_revision"`
	AppliedRevision            int64      `json:"applied_revision"`
	ReadyAt                    *time.Time `json:"ready_at"`
}

func (record AgentRecord) CurrentReadiness() string {
	evidence := record.Readiness
	if evidence == nil {
		return ""
	}
	access := evidence.Access
	if !access.Active || access.AgentID != record.AgentID || access.PrincipalID != record.OwnerUserID ||
		access.AccessRevision != record.AccessRevision || record.IdentityRevoked() ||
		record.OwnerAuthorizationSequence < 0 || evidence.OwnerRevocationSequence < 0 ||
		evidence.OwnerRevocationSequence > record.OwnerAuthorizationSequence ||
		record.FailureStage == "runtime_observation" || record.FailureCode == "lifecycle_invariant_failed" {
		return "unavailable"
	}
	if record.RuntimePreparing() {
		return "preparing"
	}
	if !record.ExecutionReady() {
		return "unavailable"
	}
	proof := evidence.Binding
	if proof == nil || proof.ReadyAt == nil ||
		proof.AgentID != record.AgentID || proof.OrganizationID != record.OrganizationID ||
		proof.AgentSpecRevisionID != record.AgentSpecRevisionID || proof.ExecutionRevisionID != record.ExecutionRevisionID ||
		proof.RuntimeRevision != record.RuntimeRevision || proof.RuntimeExecutionID != record.RuntimeExecutionID ||
		proof.OwnerUserID != record.OwnerUserID || proof.AccessRevision != record.AccessRevision ||
		proof.OwnerAuthorizationSequence != record.OwnerAuthorizationSequence ||
		proof.ReadyAfterRevision < 1 || proof.ReadyAfterRevision > proof.AppliedRevision ||
		proof.ReopenAfterRevision < 0 || proof.ReopenAfterRevision > evidence.AppliedRevision ||
		(proof.ReopenAfterRevision > 0 && proof.ReopenAfterRevision < proof.ReadyAfterRevision) ||
		proof.AppliedRevision > evidence.AppliedRevision || evidence.AppliedRevision > evidence.CommittedRevision ||
		evidence.CommittedRevision > MaximumExecutionRevision {
		return "preparing"
	}
	return "ready"
}
