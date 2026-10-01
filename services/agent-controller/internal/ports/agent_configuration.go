package ports

import (
	"context"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var ErrAgentAccessDenied = errors.New("agent access denied")

const EventAgentAuthorizationUpdated = "agent_authorization_updated"

type AgentOwnerScope struct {
	AgentID                string
	PrincipalID            string
	ExpectedAccessRevision string
}

type SetAgentAuthorization struct {
	OrganizationID          string
	Query                   AgentOwnerScope
	ExpectedRevision        int64
	OwnerRevocationSequence int64
	Authorization           domain.Authorization
	EventID                 string
	TraceID                 string
	Now                     time.Time
}

type AgentConfigurationStore interface {
	GetAgent(context.Context, string) (AgentRecord, error)
	SetAgentAuthorization(context.Context, SetAgentAuthorization) (int64, error)
	GetExecutionSynchronization(context.Context, string) (ExecutionSynchronization, error)
}
