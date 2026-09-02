package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestListGlobalAgentEventsReturnsAuthoritativeCursor(t *testing.T) {
	t.Parallel()

	store := &agentEventStoreStub{events: []ports.AgentEventRecord{
		testAgentEvent(11, "event-11", "agent-1", 3),
		testAgentEvent(12, "event-12", "agent-2", 7),
	}}
	service := NewEventService(store, store, &agentQueryStoreStub{})

	page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{
		OrganizationID: "org-1", AfterSequence: 10, Limit: 25,
	})
	if err != nil {
		t.Fatalf("list global Agent events: %v", err)
	}
	if len(page.Events) != 2 || page.NextSequence != 12 ||
		page.Events[0].GlobalSequence != 11 || page.Events[1].AgentID != "agent-2" {
		t.Fatalf("global event page = %+v", page)
	}
	if store.query.OrganizationID != "org-1" || store.query.AgentID != "" ||
		store.query.AfterSequence != 10 || store.query.Limit != 25 {
		t.Fatalf("global event query = %+v", store.query)
	}
}

func TestListGlobalAgentEventsKeepsCursorOnEmptyPage(t *testing.T) {
	t.Parallel()

	store := &agentEventStoreStub{}
	service := NewEventService(store, store, &agentQueryStoreStub{})
	page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{AfterSequence: 42})
	if err != nil {
		t.Fatalf("list empty Agent events: %v", err)
	}
	if len(page.Events) != 0 || page.NextSequence != 42 || store.query.Limit != defaultEventListLimit {
		t.Fatalf("empty event page=%+v query=%+v", page, store.query)
	}
}

func TestListAgentEventsValidatesAggregateBeforeReadingJournal(t *testing.T) {
	t.Parallel()

	agents := &agentQueryStoreStub{err: ports.ErrNotFound}
	events := &agentEventStoreStub{}
	service := NewEventService(events, events, agents)
	_, err := service.ListAgentEvents(context.Background(), ListAgentEventsInput{
		OrganizationID: "org-1", AgentID: "agent-missing", AfterSequence: 0,
	})
	if !errors.Is(err, ErrAgentNotFound) || events.listCalls != 0 {
		t.Fatalf("missing Agent error=%v event_calls=%d", err, events.listCalls)
	}

	agents.err = nil
	agents.record = queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC())
	events.events = []ports.AgentEventRecord{testAgentEvent(8, "event-8", "agent-1", 2)}
	page, err := service.ListAgentEvents(context.Background(), ListAgentEventsInput{
		OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: 7, Limit: 10,
	})
	if err != nil {
		t.Fatalf("list per-Agent events: %v", err)
	}
	if len(page.Events) != 1 || events.query.AgentID != "agent-1" || agents.getAgentID != "agent-1" {
		t.Fatalf("per-Agent page=%+v event_query=%+v Agent=%q", page, events.query, agents.getAgentID)
	}
}

func TestAgentEventsMaskCrossOrganizationAggregate(t *testing.T) {
	t.Parallel()

	agents := &agentQueryStoreStub{record: queryAgentRecord(
		"agent-1", "user-1", "available", time.Unix(1, 0).UTC(),
	)}
	events := &agentEventStoreStub{events: []ports.AgentEventRecord{
		testAgentEvent(1, "event-1", "agent-1", 1),
	}}
	service := NewEventService(events, events, agents)

	_, err := service.ListAgentEvents(context.Background(), ListAgentEventsInput{
		OrganizationID: "org-2", AgentID: "agent-1",
	})
	if !errors.Is(err, ErrAgentNotFound) || events.listCalls != 0 {
		t.Fatalf("cross-organization event error=%v event_calls=%d", err, events.listCalls)
	}
	watchErr := service.WatchAgentEvents(
		context.Background(), "org-2", "agent-1", 0, func(AgentEventView) error { return nil },
	)
	if !errors.Is(watchErr, ErrAgentNotFound) || events.subscribeCalls != 0 {
		t.Fatalf("cross-organization watch error=%v subscriptions=%d", watchErr, events.subscribeCalls)
	}
}

func TestListAgentEventsRejectsInvalidInputAndCorruptOrder(t *testing.T) {
	t.Parallel()

	tests := []ListAgentEventsInput{
		{AgentID: "not valid"},
		{AgentID: "agent-1", AfterSequence: -1},
		{AgentID: "agent-1", Limit: -1},
		{AgentID: "agent-1", Limit: maximumEventListLimit + 1},
	}
	for _, input := range tests {
		events := &agentEventStoreStub{}
		service := NewEventService(events, events, &agentQueryStoreStub{})
		_, err := service.ListAgentEvents(context.Background(), input)
		if !errors.Is(err, ErrInvalidInput) || events.listCalls != 0 {
			t.Fatalf("input=%+v error=%v calls=%d", input, err, events.listCalls)
		}
	}

	events := &agentEventStoreStub{events: []ports.AgentEventRecord{
		testAgentEvent(12, "event-12", "agent-1", 3),
		testAgentEvent(11, "event-11", "agent-1", 2),
	}}
	service := NewEventService(events, events, &agentQueryStoreStub{})
	_, err := service.ListGlobalEvents(context.Background(), ListEventsInput{AfterSequence: 10})
	if !errors.Is(err, ErrQueryContract) {
		t.Fatalf("corrupt event order error = %v", err)
	}

	unknown := testAgentEvent(11, "event-unknown", "agent-1", 2)
	unknown.EventType = "undocumented_event"
	events.events = []ports.AgentEventRecord{unknown}
	_, err = service.ListGlobalEvents(context.Background(), ListEventsInput{AfterSequence: 10})
	if !errors.Is(err, ErrQueryContract) {
		t.Fatalf("unknown event type error = %v", err)
	}
}

func TestWatchGlobalAgentEventsReplaysThenWaitsWithoutGap(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	store := &agentEventStoreStub{
		events: []ports.AgentEventRecord{testAgentEvent(1, "event-1", "agent-1", 1)},
	}
	store.onList = func() {
		store.events = append(store.events, testAgentEvent(2, "event-2", "agent-1", 2))
		store.notify()
	}
	service := NewEventService(store, store, &agentQueryStoreStub{})
	received := make([]int64, 0, 2)
	err := service.WatchGlobalEvents(ctx, "org-1", 0, func(event AgentEventView) error {
		received = append(received, event.GlobalSequence)
		if event.GlobalSequence == 2 {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("watch error = %v", err)
	}
	if len(received) != 2 || received[0] != 1 || received[1] != 2 || store.subscribeCalls == 0 {
		t.Fatalf("watch events=%v subscriptions=%d", received, store.subscribeCalls)
	}
}

func TestWatchAgentEventsFiltersJournalAfterSharedNotification(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	store := &agentEventStoreStub{
		events: []ports.AgentEventRecord{testAgentEvent(1, "event-1", "agent-1", 1)},
	}
	store.onList = func() {
		store.events = append(store.events, testAgentEvent(2, "event-other", "agent-2", 1))
		store.events = append(store.events, testAgentEvent(2, "event-2", "agent-1", 2))
		store.notify()
	}
	service := NewEventService(store, store, &agentQueryStoreStub{
		record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC()),
	})
	received := make([]int64, 0, 2)
	err := service.WatchAgentEvents(ctx, "org-1", "agent-1", 0, func(event AgentEventView) error {
		received = append(received, event.GlobalSequence)
		if event.GlobalSequence == 2 {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("watch error = %v", err)
	}
	if len(received) != 2 || received[0] != 1 || received[1] != 2 {
		t.Fatalf("watch events=%v", received)
	}
}

func testAgentEvent(
	globalSequence int64, eventID string, agentID string, aggregateSequence int64,
) ports.AgentEventRecord {
	return ports.AgentEventRecord{
		GlobalSequence: globalSequence, EventID: eventID, AgentID: agentID,
		AggregateSequence: aggregateSequence, SchemaVersion: 1,
		EventType: ports.EventAgentReady, Data: map[string]any{"result": "ok"},
		OccurredAt: time.Unix(globalSequence, 0).UTC(),
	}
}

type agentEventStoreStub struct {
	events         []ports.AgentEventRecord
	err            error
	query          ports.AgentEventQuery
	listCalls      int
	subscribeCalls int
	signal         chan struct{}
	onList         func()
}

func (store *agentEventStoreStub) ListAgentEvents(
	_ context.Context, query ports.AgentEventQuery,
) ([]ports.AgentEventRecord, error) {
	store.listCalls++
	store.query = query
	if store.err != nil {
		return nil, store.err
	}
	snapshot := append([]ports.AgentEventRecord(nil), store.events...)
	if store.onList != nil {
		callback := store.onList
		store.onList = nil
		callback()
	}
	result := make([]ports.AgentEventRecord, 0, query.Limit)
	for _, event := range snapshot {
		if event.GlobalSequence <= query.AfterSequence ||
			(query.AgentID != "" && event.AgentID != query.AgentID) {
			continue
		}
		result = append(result, event)
		if len(result) == query.Limit {
			break
		}
	}
	return result, nil
}

func (store *agentEventStoreStub) SubscribeAgentEvents() (<-chan struct{}, error) {
	store.subscribeCalls++
	if store.signal == nil {
		store.signal = make(chan struct{})
	}
	return store.signal, nil
}

func (store *agentEventStoreStub) notify() {
	if store.signal != nil {
		close(store.signal)
		store.signal = nil
	}
}

var _ ports.AgentEventStore = (*agentEventStoreStub)(nil)
var _ ports.AgentEventNotifier = (*agentEventStoreStub)(nil)
