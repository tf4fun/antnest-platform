package application

import (
	"context"
	"fmt"
	"strconv"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type SessionConfigurationInput struct {
	RequestID              string `json:"request_id"`
	AgentID                string `json:"agent_id"`
	PrincipalID            string `json:"principal_id"`
	ExpectedAccessRevision string `json:"expected_access_revision"`
	AfterID                string `json:"after_id,omitempty"`
	Limit                  int    `json:"limit,omitempty"`
}

func (service *RunService) GetSessionConfiguration(ctx context.Context, input SessionConfigurationInput) (ports.SessionConfiguration, error) {
	query, err := service.authorizeSessionConfiguration(ctx, input)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	result, err := service.store.GetSessionConfiguration(ctx, query)
	if err != nil {
		return ports.SessionConfiguration{}, mapRunError("get Session configuration", err)
	}
	return result, nil
}

type SetAgentAuthorizationInput struct {
	RequestID                     string               `json:"request_id"`
	AgentID                       string               `json:"agent_id"`
	PrincipalID                   string               `json:"principal_id"`
	ExpectedAccessRevision        string               `json:"expected_access_revision"`
	ExpectedAuthorizationRevision int64                `json:"expected_authorization_revision"`
	Authorization                 domain.Authorization `json:"authorization"`
}

func (service *RunService) SetAgentAuthorization(ctx context.Context, input SetAgentAuthorizationInput) (int64, error) {
	if input.ExpectedAuthorizationRevision < 1 {
		return 0, fmt.Errorf("%w: expected authorization revision is required", ErrInvalidInput)
	}
	authorization, err := domain.ResolveAuthorization(input.Authorization, domain.SessionConfigurationOverrides{})
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	query, err := service.authorizeSessionConfiguration(ctx, SessionConfigurationInput{
		RequestID: input.RequestID, AgentID: input.AgentID, PrincipalID: input.PrincipalID,
		ExpectedAccessRevision: input.ExpectedAccessRevision,
	})
	if err != nil {
		return 0, err
	}
	revision, err := service.store.SetAgentAuthorization(ctx, ports.SetAgentAuthorization{
		Query: query, ExpectedRevision: input.ExpectedAuthorizationRevision,
		Authorization: authorization,
		EventID:       derivedID("authorization", input.AgentID+":"+strconv.FormatInt(input.ExpectedAuthorizationRevision+1, 10)),
		TraceID:       currentTraceID(ctx), Now: service.clock.Now(),
	})
	if err != nil {
		return 0, mapRunError("set Agent authorization", err)
	}
	return revision, nil
}

func (service *RunService) authorizeSessionConfiguration(ctx context.Context, input SessionConfigurationInput) (ports.SessionConfigurationQuery, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validIdentifier(input.PrincipalID) || !validIdentifier(input.ExpectedAccessRevision) ||
		(input.AfterID != "" && !validIdentifier(input.AfterID)) || input.Limit < 0 || input.Limit > 200 {
		return ports.SessionConfigurationQuery{}, fmt.Errorf("%w: Session configuration request", ErrInvalidInput)
	}
	authorization, err := service.store.ResolveRunAuthorization(ctx, input.AgentID, input.PrincipalID, input.ExpectedAccessRevision)
	if err != nil {
		return ports.SessionConfigurationQuery{}, mapRunError("resolve configuration owner", err)
	}
	if !validIdentifier(authorization.OrganizationID) || authorization.OwnerUserID != input.PrincipalID {
		return ports.SessionConfigurationQuery{}, ErrAccessDenied
	}
	if err := service.requireActiveRunOwner(ctx, authorization.OrganizationID, authorization.OwnerUserID); err != nil {
		return ports.SessionConfigurationQuery{}, err
	}
	limit := input.Limit
	if limit == 0 {
		limit = 100
	}
	return ports.SessionConfigurationQuery{AgentID: input.AgentID, PrincipalID: input.PrincipalID,
		ExpectedAccessRevision: input.ExpectedAccessRevision, AfterID: input.AfterID, Limit: limit}, nil
}
