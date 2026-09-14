package application

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrAccessDenied = errors.New("access denied")

type AgentConfigurationService struct {
	store      ports.AgentConfigurationStore
	identities ports.OwnerAuthorizationSource
	clock      ports.Clock
}

func NewAgentConfigurationService(store ports.AgentConfigurationStore, identities ports.OwnerAuthorizationSource, clock ports.Clock) *AgentConfigurationService {
	return &AgentConfigurationService{store: store, identities: identities, clock: clock}
}

type SetAgentAuthorizationInput struct {
	RequestID                     string               `json:"request_id"`
	AgentID                       string               `json:"agent_id"`
	PrincipalID                   string               `json:"principal_id"`
	ExpectedAccessRevision        string               `json:"expected_access_revision"`
	ExpectedAuthorizationRevision int64                `json:"expected_authorization_revision"`
	Authorization                 domain.Authorization `json:"authorization"`
}

func (service *AgentConfigurationService) SetAgentAuthorization(ctx context.Context, input SetAgentAuthorizationInput) (int64, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validIdentifier(input.PrincipalID) || !validIdentifier(input.ExpectedAccessRevision) || input.ExpectedAuthorizationRevision < 1 {
		return 0, fmt.Errorf("%w: Agent authorization request", ErrInvalidInput)
	}
	authorization, err := domain.NormalizeDefaultAuthorization(input.Authorization)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	scope := ports.AgentOwnerScope{AgentID: input.AgentID, PrincipalID: input.PrincipalID, ExpectedAccessRevision: input.ExpectedAccessRevision}
	principal, err := service.authorizeOwner(ctx, scope)
	if err != nil {
		return 0, err
	}
	revision, err := service.store.SetAgentAuthorization(ctx, ports.SetAgentAuthorization{
		OrganizationID: principal.OrganizationID,
		Query:          scope, ExpectedRevision: input.ExpectedAuthorizationRevision,
		OwnerRevocationSequence: principal.LastRevocationSequence, Authorization: authorization,
		EventID: derivedID("authorization", input.AgentID+":"+strconv.FormatInt(input.ExpectedAuthorizationRevision+1, 10)),
		TraceID: currentTraceID(ctx), Now: service.clock.Now(),
	})
	if err != nil {
		return 0, mapAgentConfigurationError("set Agent authorization", err)
	}
	return revision, nil
}

func (service *AgentConfigurationService) authorizeOwner(ctx context.Context, scope ports.AgentOwnerScope) (ports.IdentityPrincipal, error) {
	agent, err := service.store.GetAgent(ctx, scope.AgentID)
	if err != nil {
		return ports.IdentityPrincipal{}, mapAgentConfigurationError("read Agent owner", err)
	}
	if agent.AgentID != scope.AgentID || !validIdentifier(agent.OrganizationID) || agent.OwnerUserID != scope.PrincipalID ||
		agent.AccessRevision != scope.ExpectedAccessRevision || agent.IdentityRevoked() || agent.DesiredState == domain.DesiredDeleted {
		return ports.IdentityPrincipal{}, ErrAccessDenied
	}
	if service.identities == nil {
		return ports.IdentityPrincipal{}, fmt.Errorf("%w: Agent owner identity directory is not configured", ErrDependencyUnavailable)
	}
	principal, err := service.identities.ResolveOwnerAuthorization(ctx, agent.OrganizationID, agent.OwnerUserID)
	if identityReferenceMissing(err) {
		return ports.IdentityPrincipal{}, ErrAccessDenied
	}
	if err != nil {
		return ports.IdentityPrincipal{}, fmt.Errorf("%w: resolve Agent owner", ErrDependencyUnavailable)
	}
	if principal.UserID != agent.OwnerUserID || principal.OrganizationID != agent.OrganizationID ||
		strings.TrimSpace(principal.MembershipID) == "" || !principal.Active || principal.LastRevocationSequence < 0 ||
		principal.LastRevocationSequence != agent.OwnerAuthorizationSequence {
		return ports.IdentityPrincipal{}, ErrAccessDenied
	}
	return principal, nil
}

func mapAgentConfigurationError(action string, err error) error {
	switch {
	case errors.Is(err, ports.ErrAgentAccessDenied):
		return fmt.Errorf("%w: %s", ErrAccessDenied, action)
	case errors.Is(err, ports.ErrNotFound):
		return fmt.Errorf("%w: %s", ErrAgentNotFound, action)
	default:
		return fmt.Errorf("%s: %w", action, err)
	}
}
