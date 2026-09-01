package application

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const (
	defaultEventListLimit = 100
	maximumEventListLimit = 500
)

var traceIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type EventService struct {
	events ports.AgentEventStore
	agents ports.AgentQueryStore
}

func NewEventService(events ports.AgentEventStore, agents ports.AgentQueryStore) *EventService {
	return &EventService{events: events, agents: agents}
}

type ListEventsInput struct {
	AfterSequence int64
	Limit         int
}

type ListAgentEventsInput struct {
	AgentID       string
	AfterSequence int64
	Limit         int
}

type AgentEventView struct {
	EventID            string
	GlobalSequence     int64
	AggregateSequence  int64
	SchemaVersion      int
	AgentID            string
	EventType          string
	OperationRequestID string
	AdmissionID        string
	TraceID            string
	OccurredAt         time.Time
	Data               map[string]any
}

type AgentEventPage struct {
	Events       []AgentEventView
	NextSequence int64
}

type AgentEventEmitter func(AgentEventView) error

func (service *EventService) ListGlobalEvents(
	ctx context.Context, input ListEventsInput,
) (AgentEventPage, error) {
	query, err := buildEventQuery("", input.AfterSequence, input.Limit)
	if err != nil {
		return AgentEventPage{}, err
	}
	return service.listEvents(ctx, query)
}

func (service *EventService) ListAgentEvents(
	ctx context.Context, input ListAgentEventsInput,
) (AgentEventPage, error) {
	query, err := buildEventQuery(input.AgentID, input.AfterSequence, input.Limit)
	if err != nil {
		return AgentEventPage{}, err
	}
	if err := service.ensureAgentExists(ctx, input.AgentID); err != nil {
		return AgentEventPage{}, err
	}
	return service.listEvents(ctx, query)
}

func (service *EventService) WatchGlobalEvents(
	ctx context.Context, afterSequence int64, emit AgentEventEmitter,
) error {
	if afterSequence < 0 || emit == nil {
		return fmt.Errorf("%w: Agent event watch", ErrInvalidInput)
	}
	return service.watchEvents(ctx, "", afterSequence, emit)
}

func (service *EventService) WatchAgentEvents(
	ctx context.Context, agentID string, afterSequence int64, emit AgentEventEmitter,
) error {
	if !validIdentifier(agentID) || afterSequence < 0 || emit == nil {
		return fmt.Errorf("%w: Agent event watch", ErrInvalidInput)
	}
	if err := service.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	return service.watchEvents(ctx, agentID, afterSequence, emit)
}

func (service *EventService) watchEvents(
	ctx context.Context, agentID string, afterSequence int64, emit AgentEventEmitter,
) error {
	cursor := afterSequence
	for {
		page, err := service.listEvents(ctx, ports.AgentEventQuery{
			AgentID: agentID, AfterSequence: cursor, Limit: maximumEventListLimit,
		})
		if err != nil {
			return err
		}
		for _, event := range page.Events {
			if err := emit(event); err != nil {
				return err
			}
		}
		cursor = page.NextSequence
		if len(page.Events) == maximumEventListLimit {
			continue
		}
		if err := service.events.WaitForAgentEvents(ctx, agentID, cursor); err != nil {
			return fmt.Errorf("wait for Agent events: %w", err)
		}
	}
}

func (service *EventService) listEvents(
	ctx context.Context, query ports.AgentEventQuery,
) (AgentEventPage, error) {
	records, err := service.events.ListAgentEvents(ctx, query)
	if err != nil {
		return AgentEventPage{}, fmt.Errorf("list Agent events: %w", err)
	}
	if err := validateEventRecords(records, query); err != nil {
		return AgentEventPage{}, err
	}
	page := AgentEventPage{
		Events: make([]AgentEventView, 0, len(records)), NextSequence: query.AfterSequence,
	}
	for _, record := range records {
		page.Events = append(page.Events, agentEventView(record))
		page.NextSequence = record.GlobalSequence
	}
	return page, nil
}

func (service *EventService) ensureAgentExists(ctx context.Context, agentID string) error {
	_, err := service.agents.GetAgent(ctx, agentID)
	if errors.Is(err, ports.ErrNotFound) {
		return fmt.Errorf("%w: %s", ErrAgentNotFound, agentID)
	}
	if err != nil {
		return fmt.Errorf("get Agent for event query: %w", err)
	}
	return nil
}

func buildEventQuery(agentID string, afterSequence int64, limit int) (ports.AgentEventQuery, error) {
	if (agentID != "" && !validIdentifier(agentID)) || afterSequence < 0 {
		return ports.AgentEventQuery{}, fmt.Errorf("%w: Agent event query", ErrInvalidInput)
	}
	if limit == 0 {
		limit = defaultEventListLimit
	}
	if limit < 1 || limit > maximumEventListLimit {
		return ports.AgentEventQuery{}, fmt.Errorf("%w: Agent event limit", ErrInvalidInput)
	}
	return ports.AgentEventQuery{AgentID: agentID, AfterSequence: afterSequence, Limit: limit}, nil
}

func validateEventRecords(records []ports.AgentEventRecord, query ports.AgentEventQuery) error {
	if len(records) > query.Limit {
		return fmt.Errorf("%w: Agent event store returned %d rows for limit %d", ErrQueryContract, len(records), query.Limit)
	}
	previous := query.AfterSequence
	for _, record := range records {
		if record.GlobalSequence <= previous || record.AggregateSequence < 1 ||
			record.SchemaVersion != 1 || !validIdentifier(record.EventID) ||
			!validIdentifier(record.AgentID) || strings.TrimSpace(record.EventType) == "" ||
			record.OccurredAt.IsZero() || record.Data == nil ||
			(query.AgentID != "" && record.AgentID != query.AgentID) ||
			(record.OperationRequestID != "" && !validIdentifier(record.OperationRequestID)) ||
			(record.AdmissionID != "" && !validIdentifier(record.AdmissionID)) ||
			(record.TraceID != "" && !traceIDPattern.MatchString(record.TraceID)) {
			return fmt.Errorf("%w: invalid Agent event envelope", ErrQueryContract)
		}
		previous = record.GlobalSequence
	}
	return nil
}

func agentEventView(record ports.AgentEventRecord) AgentEventView {
	return AgentEventView{
		EventID: record.EventID, GlobalSequence: record.GlobalSequence,
		AggregateSequence: record.AggregateSequence, SchemaVersion: record.SchemaVersion,
		AgentID: record.AgentID, EventType: record.EventType,
		OperationRequestID: record.OperationRequestID, AdmissionID: record.AdmissionID,
		TraceID: record.TraceID, OccurredAt: record.OccurredAt, Data: record.Data,
	}
}
