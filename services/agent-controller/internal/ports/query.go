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

// WorkspaceAgentQuery selects the active access projection consumed by Edge Gateway.
// The access subject remains an internal routing credential and must not reach a browser.
type WorkspaceAgentQuery struct {
	AgentID        string
	OrganizationID string
	PrincipalID    string
	AfterCreatedAt time.Time
	AfterAgentID   string
	Limit          int
}

type WorkspaceAgentRecord struct {
	DesiredState         domain.DesiredState
	ActiveOperation      bool
	AggregateSequence    int64
	SessionID            string
	AdmissionPrincipalID string
	IdentityRevoked      bool
	AgentID              string
	Name                 string
	LifecycleState       domain.AgentState
	AccessSubject        string
	AdmissionState       domain.AdmissionState
	CreatedAt            time.Time
}

// AgentConfigurationRecord is the immutable executable configuration selected
// by an Agent projection. Catalog names are presentation metadata; Snapshot is
// the frozen authority used by the execution revision.
type AgentConfigurationRecord struct {
	AgentID              string
	AgentSpecRevisionID  string
	TemplateName         string
	ModelProfileID       string
	ModelProfileName     string
	ModelProfileRevision int64
	Snapshot             domain.AgentSpecSnapshot
}

type AgentQueryStore interface {
	GetAgent(context.Context, string) (AgentRecord, error)
	GetAgentConfiguration(context.Context, string, string) (AgentConfigurationRecord, error)
	ListAgents(context.Context, AgentQuery) ([]AgentRecord, error)
	ListWorkspaceAgents(context.Context, WorkspaceAgentQuery) ([]WorkspaceAgentRecord, error)
}
