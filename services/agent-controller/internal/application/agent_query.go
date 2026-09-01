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
	OrganizationID string
	OwnerUserID    string
	LifecycleState domain.AgentState
	IncludeDeleted bool
	Limit          int
	Cursor         string
}

type AgentPage struct {
	Items      []AgentView
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
	return agentView(record), nil
}

func (service *AgentQueryService) ListAgents(
	ctx context.Context, input ListAgentsInput,
) (AgentPage, error) {
	query, pageLimit, err := buildAgentQuery(input)
	if err != nil {
		return AgentPage{}, err
	}
	if !query.IncludeDeleted &&
		(query.LifecycleState == domain.AgentDeleting || query.LifecycleState == domain.AgentDeleted) {
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

func buildAgentQuery(input ListAgentsInput) (ports.AgentQuery, int, error) {
	if (input.OrganizationID != "" && !validIdentifier(input.OrganizationID)) ||
		(input.OwnerUserID != "" && !validIdentifier(input.OwnerUserID)) ||
		!validAgentStateFilter(input.LifecycleState) {
		return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent list filter", ErrInvalidInput)
	}
	limit := input.Limit
	if limit == 0 {
		limit = defaultAgentListLimit
	}
	if limit < 1 || limit > maximumAgentListLimit {
		return ports.AgentQuery{}, 0, fmt.Errorf("%w: Agent list limit", ErrInvalidInput)
	}
	query := ports.AgentQuery{
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
	case "", domain.AgentProvisioning, domain.AgentAvailable, domain.AgentUnavailable,
		domain.AgentDisabled, domain.AgentDeleting, domain.AgentDeleted:
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
