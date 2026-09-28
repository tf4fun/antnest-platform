package application

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const (
	defaultAgentListLimit = 100
	maximumAgentListLimit = 200
	agentCursorVersion    = 1
	maximumCursorLength   = 2048
)

var ErrQueryContract = errors.New("query store contract violation")

type AgentQueryService struct {
	store ports.AgentQueryStore
}

func NewAgentQueryService(store ports.AgentQueryStore) *AgentQueryService {
	return &AgentQueryService{store: store}
}

type ListAgentsInput struct {
	ActivationState domain.ActivationState
	RuntimeState    domain.RuntimeState
	OrganizationID  string
	OwnerUserID     string
	LifecycleState  domain.AgentState
	IncludeDeleted  bool
	Limit           int
	Cursor          string
}

type AgentPage struct {
	Items      []AgentView
	NextCursor string
}

type ListWorkspaceAgentsInput struct {
	RequestID      string
	OrganizationID string
	PrincipalID    string
	Limit          int
	Cursor         string
}

type WorkspaceAgentView struct {
	AgentID         string
	Name            string
	LifecycleState  domain.AgentState
	ActivationState domain.ActivationState
	RuntimeState    domain.RuntimeState
}

type WorkspaceAgentPage struct {
	Items      []WorkspaceAgentView
	NextCursor string
}

func (service *AgentQueryService) GetAgent(
	ctx context.Context, agentID string,
) (AgentView, error) {
	if !validIdentifier(agentID) {
		return AgentView{}, fmt.Errorf("%w: Agent ID", ErrInvalidInput)
	}
	record, err := service.store.GetAgent(ctx, agentID)
	if errors.Is(err, ports.ErrNotFound) {
		return AgentView{}, fmt.Errorf("%w: %s", ErrAgentNotFound, agentID)
	}
	if err != nil {
		return AgentView{}, fmt.Errorf("get Agent projection: %w", err)
	}
	return service.agentProjection(ctx, record)
}

func (service *AgentQueryService) GetAgentForOrganization(
	ctx context.Context, organizationID string, agentID string,
) (AgentView, error) {
	if !validIdentifier(organizationID) || !validIdentifier(agentID) {
		return AgentView{}, fmt.Errorf("%w: Agent scope", ErrInvalidInput)
	}
	record, err := service.store.GetAgent(ctx, agentID)
	if errors.Is(err, ports.ErrNotFound) || err == nil && record.OrganizationID != organizationID {
		return AgentView{}, fmt.Errorf("%w: %s", ErrAgentNotFound, agentID)
	}
	if err != nil {
		return AgentView{}, fmt.Errorf("get Agent projection: %w", err)
	}
	return service.agentProjection(ctx, record)
}

func (service *AgentQueryService) agentProjection(
	ctx context.Context, record ports.AgentRecord,
) (AgentView, error) {
	view := agentView(record)
	if record.AgentSpecRevisionID == "" {
		return view, nil
	}
	configuration, err := service.store.GetAgentConfiguration(
		ctx, record.AgentID, record.AgentSpecRevisionID,
	)
	if errors.Is(err, ports.ErrNotFound) {
		return AgentView{}, fmt.Errorf(
			"%w: executable configuration for Agent %s", ErrQueryContract, record.AgentID,
		)
	}
	if err != nil {
		return AgentView{}, fmt.Errorf("get Agent configuration projection: %w", err)
	}
	if configuration.AgentID != record.AgentID ||
		configuration.AgentSpecRevisionID != record.AgentSpecRevisionID {
		return AgentView{}, fmt.Errorf(
			"%w: mismatched executable configuration for Agent %s", ErrQueryContract, record.AgentID,
		)
	}
	snapshot := configuration.Snapshot
	view.Configuration = &AgentConfigurationView{
		TemplateID: snapshot.TemplateID, TemplateRevision: snapshot.TemplateRevision,
		TemplateName:           configuration.TemplateName,
		ModelProfileID:         configuration.ModelProfileID,
		ModelProfileRevisionID: snapshot.ModelProfileRevisionID,
		ModelProfileRevision:   configuration.ModelProfileRevision,
		ModelProfileName:       configuration.ModelProfileName, Model: snapshot.Model,
		MaxModelRequests:     snapshot.MaxModelRequests,
		ContextPolicyVersion: snapshot.ContextPolicyVersion, Runtime: snapshot.Runtime,
		SystemSkills:   snapshot.SystemSkills,
		SkillSetDigest: snapshot.SkillSetDigest,
	}
	return view, nil
}

func (service *AgentQueryService) ListAgents(
	ctx context.Context, input ListAgentsInput,
) (AgentPage, error) {
	query, pageLimit, err := buildAgentQuery(input)
	if err != nil {
		return AgentPage{}, err
	}
	if !query.IncludeDeleted && query.LifecycleState == domain.AgentDeleted {
		return AgentPage{Items: []AgentView{}}, nil
	}
	records, err := service.store.ListAgents(ctx, query)
	if err != nil {
		return AgentPage{}, fmt.Errorf("list Agent projections: %w", err)
	}
	if len(records) > query.Limit {
		return AgentPage{}, fmt.Errorf("%w: Agent store returned %d rows for limit %d", ErrQueryContract, len(records), query.Limit)
	}

	hasNext := len(records) > pageLimit
	if hasNext {
		records = records[:pageLimit]
	}
	page := AgentPage{Items: make([]AgentView, 0, len(records))}
	for _, record := range records {
		page.Items = append(page.Items, agentView(record))
	}
	if hasNext {
		page.NextCursor, err = encodeAgentCursor(records[len(records)-1])
		if err != nil {
			return AgentPage{}, err
		}
	}
	return page, nil
}

func (service *AgentQueryService) ListWorkspaceAgents(
	ctx context.Context, input ListWorkspaceAgentsInput,
) (WorkspaceAgentPage, error) {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.PrincipalID) {
		return WorkspaceAgentPage{}, fmt.Errorf("%w: workspace Agent scope", ErrInvalidInput)
	}
	pageLimit := input.Limit
	if pageLimit == 0 {
		pageLimit = defaultAgentListLimit
	}
	if pageLimit < 1 || pageLimit > maximumAgentListLimit {
		return WorkspaceAgentPage{}, fmt.Errorf("%w: workspace Agent list limit", ErrInvalidInput)
	}
	query := ports.WorkspaceAgentQuery{
		OrganizationID: input.OrganizationID, PrincipalID: input.PrincipalID,
		Limit: pageLimit + 1,
	}
	if input.Cursor != "" {
		var err error
		query.AfterCreatedAt, query.AfterAgentID, err = decodeAgentCursor(input.Cursor)
		if err != nil {
			return WorkspaceAgentPage{}, fmt.Errorf("%w: workspace Agent cursor", ErrInvalidInput)
		}
	}
	records, err := service.store.ListWorkspaceAgents(ctx, query)
	if err != nil {
		return WorkspaceAgentPage{}, fmt.Errorf("list workspace Agent projections: %w", err)
	}
	if len(records) > query.Limit {
		return WorkspaceAgentPage{}, fmt.Errorf(
			"%w: workspace Agent store returned %d rows for limit %d",
			ErrQueryContract, len(records), query.Limit,
		)
	}
	hasNext := len(records) > pageLimit
	if hasNext {
		records = records[:pageLimit]
	}
	page := WorkspaceAgentPage{Items: make([]WorkspaceAgentView, 0, len(records))}
	for _, record := range records {
		page.Items = append(page.Items, WorkspaceAgentView{
			AgentID: record.AgentID, Name: record.Name,
			LifecycleState: record.LifecycleState, ActivationState: record.ActivationState, RuntimeState: record.RuntimeState,
		})
	}
	if hasNext {
		last := records[len(records)-1]
		page.NextCursor, err = encodeAgentCursor(ports.AgentRecord{
			AgentID: last.AgentID, CreatedAt: last.CreatedAt,
		})
		if err != nil {
			return WorkspaceAgentPage{}, err
		}
	}
	return page, nil
}

func buildAgentQuery(input ListAgentsInput) (ports.AgentQuery, int, error) {
	if (input.OrganizationID != "" && !validIdentifier(input.OrganizationID)) ||
		(input.OwnerUserID != "" && !validIdentifier(input.OwnerUserID)) ||
		!validAgentStateFilter(input.LifecycleState) {
		return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent list filter", ErrInvalidInput)
	}
	if !validActivationFilter(input.ActivationState) || !validRuntimeFilter(input.RuntimeState) {
		return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent status filter", ErrInvalidInput)
	}
	limit := input.Limit
	if limit == 0 {
		limit = defaultAgentListLimit
	}
	if limit < 1 || limit > maximumAgentListLimit {
		return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent list limit", ErrInvalidInput)
	}
	query := ports.AgentQuery{
		ActivationState: input.ActivationState, RuntimeState: input.RuntimeState,
		OrganizationID: input.OrganizationID, OwnerUserID: input.OwnerUserID,
		LifecycleState: input.LifecycleState, IncludeDeleted: input.IncludeDeleted,
		Limit: limit + 1,
	}
	if input.Cursor != "" {
		var err error
		query.AfterCreatedAt, query.AfterAgentID, err = decodeAgentCursor(input.Cursor)
		if err != nil {
			return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent list cursor", ErrInvalidInput)
		}
	}
	return query, limit, nil
}

func validAgentStateFilter(state domain.AgentState) bool {
	switch state {
	case "", domain.AgentNotCreated, domain.AgentCreated, domain.AgentDeleted:
		return true
	default:
		return false
	}
}

func validActivationFilter(state domain.ActivationState) bool {
	return state == "" || state == domain.ActivationEnabled || state == domain.ActivationDisabled
}

func validRuntimeFilter(state domain.RuntimeState) bool {
	switch state {
	case "", domain.RuntimeUnknown, domain.RuntimeWaiting, domain.RuntimeAvailable, domain.RuntimeUnhealthy, domain.RuntimeExited, domain.RuntimeAbsent:
		return true
	default:
		return false
	}
}

type agentCursor struct {
	Version   int    `json:"v"`
	CreatedAt string `json:"created_at"`
	AgentID   string `json:"agent_id"`
}

func encodeAgentCursor(record ports.AgentRecord) (string, error) {
	if record.CreatedAt.IsZero() || !validIdentifier(record.AgentID) {
		return "", fmt.Errorf("%w: invalid Agent projection key", ErrQueryContract)
	}
	payload, err := json.Marshal(agentCursor{
		Version: agentCursorVersion, CreatedAt: record.CreatedAt.UTC().Format(time.RFC3339Nano),
		AgentID: record.AgentID,
	})
	if err != nil {
		return "", fmt.Errorf("encode Agent cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeAgentCursor(value string) (time.Time, string, error) {
	if len(value) > maximumCursorLength {
		return time.Time{}, "", ErrInvalidInput
	}
	payload, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return time.Time{}, "", ErrInvalidInput
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var cursor agentCursor
	if err := decoder.Decode(&cursor); err != nil {
		return time.Time{}, "", ErrInvalidInput
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return time.Time{}, "", ErrInvalidInput
	}
	createdAt, err := time.Parse(time.RFC3339Nano, cursor.CreatedAt)
	if err != nil || createdAt.IsZero() || cursor.Version != agentCursorVersion ||
		!validIdentifier(cursor.AgentID) {
		return time.Time{}, "", ErrInvalidInput
	}
	canonical, err := encodeAgentCursor(ports.AgentRecord{
		AgentID: cursor.AgentID, CreatedAt: createdAt,
	})
	if err != nil || canonical != value {
		return time.Time{}, "", ErrInvalidInput
	}
	return createdAt.UTC(), cursor.AgentID, nil
}
