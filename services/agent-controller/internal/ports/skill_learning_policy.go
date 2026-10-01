package ports

import (
	"context"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

// SkillLearningPolicyScope is checked against the current Agent owner and
// organization by the repository, including the identity revocation watermark.
type SkillLearningPolicyScope struct {
	OrganizationID          string
	AgentID                 string
	OwnerPrincipalID        string
	AccessRevision          string
	OwnerRevocationSequence int64
}

type SetSkillLearningPolicy struct {
	Scope            SkillLearningPolicyScope
	RequestID        string
	ExpectedRevision string
	Policy           domain.SkillLearningPolicy
}

type SkillLearningPolicyStore interface {
	GetAgent(context.Context, string) (AgentRecord, error)
	GetSkillLearningPolicy(context.Context, SkillLearningPolicyScope) (domain.SkillLearningPolicy, error)
	SetSkillLearningPolicy(context.Context, SetSkillLearningPolicy) (domain.SkillLearningPolicy, error)
}
