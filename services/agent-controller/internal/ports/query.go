package ports

import (
	"context"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

// AgentQuery contains only projection predicates understood by the storage adapter.
// Cursor encoding and page construction belong to the application layer.
type AgentQuery struct {
	OrganizationID string
	OwnerUserID    string
	LifecycleState domain.AgentState
	IncludeDeleted bool
	AfterCreatedAt time.Time
	AfterAgentID   string
	Limit          int
}

type AgentQueryStore interface {
	GetAgent(context.Context, string) (AgentRecord, error)
	ListAgents(context.Context, AgentQuery) ([]AgentRecord, error)
}
