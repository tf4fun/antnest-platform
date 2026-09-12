package ports

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

var ErrModelUnavailable = errors.New("selected model is unavailable")

const EventAgentAuthorizationUpdated = "agent_authorization_updated"

type SessionModelOption struct {
	ModelProfileID  string `json:"model_profile_id"`
	RevisionID      string `json:"revision_id"`
	DisplayName     string `json:"display_name"`
	Model           string `json:"model"`
	ContextWindow   int    `json:"context_window"`
	MaxOutputTokens int    `json:"max_output_tokens"`
	SupportsImages  bool   `json:"supports_images"`
}

type DefaultSessionModel struct {
	SessionModelOption
	Available bool `json:"available"`
}

type SessionConfiguration struct {
	Models                []SessionModelOption `json:"models"`
	NextCursor            string               `json:"next_cursor"`
	DefaultModel          DefaultSessionModel  `json:"default_model"`
	DefaultAuthorization  domain.Authorization `json:"default_authorization"`
	AuthorizationRevision int64                `json:"authorization_revision"`
}

type AdmittedConfiguration struct {
	ModelProfileID         string               `json:"model_profile_id"`
	ModelProfileRevisionID string               `json:"model_profile_revision_id"`
	Authorization          domain.Authorization `json:"authorization"`
	AuthorizationRevision  int64                `json:"authorization_revision"`
	Digest                 string               `json:"digest"`
}

type SessionConfigurationQuery struct {
	AgentID                string
	PrincipalID            string
	ExpectedAccessRevision string
	AfterID                string
	Limit                  int
}

type SetAgentAuthorization struct {
	Query            SessionConfigurationQuery
	ExpectedRevision int64
	Authorization    domain.Authorization
	EventID          string
	TraceID          string
	Now              time.Time
}

type SessionConfigurationStore interface {
	GetSessionConfiguration(context.Context, SessionConfigurationQuery) (SessionConfiguration, error)
	SetAgentAuthorization(context.Context, SetAgentAuthorization) (int64, error)
}
