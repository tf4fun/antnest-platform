package domain

import (
	"fmt"
	"regexp"
)

const RuntimeBarrierRecoveryMaxRevision int64 = 9007199254740991

var runtimeBarrierPolicyIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)

// RuntimeBarrierRecoveryPolicy is an organization-level policy snapshot. Revision
// zero is a logical default only; reading it must not create a database row.
type RuntimeBarrierRecoveryPolicy struct {
	OrganizationID string `json:"organization_id"`
	Revision       int64  `json:"revision"`
	Mode           string `json:"mode"`
	CooldownMS     int64  `json:"cooldown_ms"`
}

func DefaultRuntimeBarrierRecoveryPolicy(organizationID string) RuntimeBarrierRecoveryPolicy {
	return RuntimeBarrierRecoveryPolicy{OrganizationID: organizationID, Mode: "manual", CooldownMS: 300000}
}

func ValidRuntimeBarrierPolicyIdentifier(value string) bool {
	return runtimeBarrierPolicyIdentifier.MatchString(value)
}

func (policy RuntimeBarrierRecoveryPolicy) Validate() error {
	if !ValidRuntimeBarrierPolicyIdentifier(policy.OrganizationID) || policy.Revision < 0 ||
		policy.Revision > RuntimeBarrierRecoveryMaxRevision ||
		(policy.Mode != "auto" && policy.Mode != "notify" && policy.Mode != "manual") ||
		policy.CooldownMS < 60000 || policy.CooldownMS > 86400000 {
		return fmt.Errorf("invalid Runtime barrier recovery policy")
	}
	if policy.Revision == 0 && (policy.Mode != "manual" || policy.CooldownMS != 300000) {
		return fmt.Errorf("invalid Runtime barrier recovery default")
	}
	return nil
}
