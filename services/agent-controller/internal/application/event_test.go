package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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

func TestListAgentEventsPreservesEveryLegacyV1EventType(t *testing.T) {
	t.Parallel()

	for _, eventType := range legacyReadinessReaderEventTypes() {
		t.Run(eventType, func(t *testing.T) {
			t.Parallel()
			for _, data := range []map[string]any{
				{},
				{"historical_field": "retained", "result": map[string]any{"ok": true}},
			} {
				record := testAgentEvent(11, "event-legacy", "agent-1", 3)
				record.EventType = eventType
				record.Data = data
				store := &agentEventStoreStub{events: []ports.AgentEventRecord{record}}
				service := NewEventService(store, store, &agentQueryStoreStub{})
				page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{
					OrganizationID: "org-1", AfterSequence: 10,
				})
				if err != nil || len(page.Events) != 1 || page.NextSequence != 11 {
					t.Fatalf("legacy event page=%+v error=%v", page, err)
				}
				assertReadinessReaderEvent(t, page.Events[0], record)
			}
		})
	}
}

func TestListAgentEventsAcceptsV2ReadinessProof(t *testing.T) {
	t.Parallel()

	for _, eventType := range []string{ports.EventRuntimeBound, ports.EventAgentReady} {
		for _, shape := range []string{"decoded JSON", "minimum revision", "maximum revision", "identifier boundaries", "no optional envelope identity", "ACK below threshold"} {
			if shape == "ACK below threshold" && eventType != ports.EventAgentReady {
				continue
			}
			t.Run(eventType+"/"+shape, func(t *testing.T) {
				t.Parallel()
				record := readinessReaderEvent(t, 11, eventType)
				if _, ok := record.Data["ready_after_revision"].(float64); !ok {
					t.Fatal("proof must use the numeric representation from json.Unmarshal")
				}
				switch shape {
				case "minimum revision", "maximum revision":
					revision := float64(1)
					if shape == "maximum revision" {
						revision = 9007199254740991
					}
					record.Data["ready_after_revision"] = revision
					if eventType == ports.EventAgentReady {
						record.Data["applied_revision"] = revision
					}
				case "identifier boundaries":
					record.Data["organization_id"] = "0"
					record.Data["agent_spec_revision_id"] = strings.Repeat("a", 200)
					record.Data["execution_revision_id"] = "Execution_1.2-3"
					record.Data["runtime_revision"] = "9_.-"
				case "no optional envelope identity":
					record.OperationRequestID = ""
					record.TraceID = ""
				case "ACK below threshold":
					// Threshold satisfaction belongs to the owning transaction, not wire decoding.
					record.Data["applied_revision"] = float64(7)
				}
				store := &agentEventStoreStub{events: []ports.AgentEventRecord{record}}
				service := NewEventService(store, store, &agentQueryStoreStub{})
				page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{
					OrganizationID: "org-1", AfterSequence: 10,
				})
				if err != nil || len(page.Events) != 1 || page.NextSequence != 11 {
					t.Fatalf("v2 event page=%+v error=%v", page, err)
				}
				assertReadinessReaderEvent(t, page.Events[0], record)
			})
		}
	}
}

func TestListAgentEventsPaginatesMixedReadinessVersions(t *testing.T) {
	t.Parallel()

	for _, perAgent := range []bool{false, true} {
		t.Run(strconv.FormatBool(perAgent), func(t *testing.T) {
			t.Parallel()
			records := mixedReadinessReaderEvents(t)
			store := &agentEventStoreStub{events: records}
			service := NewEventService(store, store, &agentQueryStoreStub{
				record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC()),
			})
			wanted := make([]ports.AgentEventRecord, 0, len(records))
			for _, record := range records {
				if !perAgent || record.AgentID == "agent-1" {
					wanted = append(wanted, record)
				}
			}
			cursor := int64(10)
			for offset := 0; offset < len(wanted); {
				var page AgentEventPage
				var err error
				if perAgent {
					page, err = service.ListAgentEvents(context.Background(), ListAgentEventsInput{
						OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: cursor, Limit: 2,
					})
				} else {
					page, err = service.ListGlobalEvents(context.Background(), ListEventsInput{
						OrganizationID: "org-1", AfterSequence: cursor, Limit: 2,
					})
				}
				count := min(2, len(wanted)-offset)
				if err != nil || len(page.Events) != count || page.NextSequence != wanted[offset+count-1].GlobalSequence {
					t.Fatalf("offset=%d page=%+v error=%v", offset, page, err)
				}
				wantedAgent := ""
				if perAgent {
					wantedAgent = "agent-1"
				}
				if store.query != (ports.AgentEventQuery{
					OrganizationID: "org-1", AgentID: wantedAgent, AfterSequence: cursor, Limit: 2,
				}) {
					t.Fatalf("mixed-version query = %+v", store.query)
				}
				for index, event := range page.Events {
					assertReadinessReaderEvent(t, event, wanted[offset+index])
				}
				offset += count
				cursor = page.NextSequence
			}
			var empty AgentEventPage
			var err error
			if perAgent {
				empty, err = service.ListAgentEvents(context.Background(), ListAgentEventsInput{
					OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: cursor, Limit: 2,
				})
			} else {
				empty, err = service.ListGlobalEvents(context.Background(), ListEventsInput{
					OrganizationID: "org-1", AfterSequence: cursor, Limit: 2,
				})
			}
			if err != nil || len(empty.Events) != 0 || empty.NextSequence != cursor {
				t.Fatalf("empty mixed-version page=%+v error=%v", empty, err)
			}
		})
	}
}

func TestWatchAgentEventsContinuesAcrossReadinessVersions(t *testing.T) {
	t.Parallel()

	for _, perAgent := range []bool{false, true} {
		t.Run(strconv.FormatBool(perAgent), func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			records := mixedReadinessReaderEvents(t)
			store := &agentEventStoreStub{events: records[:1]}
			store.onList = func() {
				store.events = append(store.events, records[1:]...)
				store.notify()
			}
			service := NewEventService(store, store, &agentQueryStoreStub{
				record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC()),
			})
			received := make([]AgentEventView, 0, len(records))
			emit := func(event AgentEventView) error {
				received = append(received, event)
				if event.GlobalSequence == 17 {
					cancel()
				}
				return nil
			}
			var err error
			if perAgent {
				err = service.WatchAgentEvents(ctx, "org-1", "agent-1", 10, emit)
			} else {
				err = service.WatchGlobalEvents(ctx, "org-1", 10, emit)
			}
			if !errors.Is(err, context.Canceled) || store.listCalls != 2 || store.subscribeCalls != 2 {
				t.Fatalf("watch error=%v lists=%d subscriptions=%d", err, store.listCalls, store.subscribeCalls)
			}
			wanted := make([]ports.AgentEventRecord, 0, len(records))
			for _, record := range records {
				if !perAgent || record.AgentID == "agent-1" {
					wanted = append(wanted, record)
				}
			}
			if len(received) != len(wanted) || store.query.OrganizationID != "org-1" || store.query.AfterSequence != 11 {
				t.Fatalf("watch received=%+v query=%+v", received, store.query)
			}
			if perAgent && store.query.AgentID != "agent-1" || !perAgent && store.query.AgentID != "" {
				t.Fatalf("watch Agent scope = %q", store.query.AgentID)
			}
			for index, event := range received {
				assertReadinessReaderEvent(t, event, wanted[index])
			}
		})
	}
}

func TestListAgentEventsRejectsInvalidReadinessProof(t *testing.T) {
	t.Parallel()

	tests := make([]struct {
		name   string
		record ports.AgentEventRecord
	}, 0)
	add := func(name string, eventType string, mutate func(*ports.AgentEventRecord)) {
		record := readinessReaderEvent(t, 11, eventType)
		mutate(&record)
		tests = append(tests, struct {
			name   string
			record ports.AgentEventRecord
		}{name: name, record: record})
	}
	for _, version := range []int{-1, 0, 3} {
		add("version/"+strconv.Itoa(version), ports.EventAgentReady, func(record *ports.AgentEventRecord) {
			record.SchemaVersion = version
		})
	}
	add("v1 runtime_bound", ports.EventRuntimeBound, func(record *ports.AgentEventRecord) {
		record.SchemaVersion = 1
	})
	for _, eventType := range append(legacyReadinessReaderEventTypes(), "unknown_event") {
		if eventType != ports.EventAgentReady {
			add("v2 type/"+eventType, ports.EventAgentReady, func(record *ports.AgentEventRecord) {
				record.EventType = eventType
			})
		}
	}
	for _, eventType := range []string{ports.EventRuntimeBound, ports.EventAgentReady} {
		fields := []string{"organization_id", "agent_spec_revision_id", "execution_revision_id", "runtime_revision", "ready_after_revision"}
		if eventType == ports.EventAgentReady {
			fields = append(fields, "applied_revision")
		}
		add(eventType+"/nil data", eventType, func(record *ports.AgentEventRecord) { record.Data = nil })
		for _, field := range fields {
			add(eventType+"/missing/"+field, eventType, func(record *ports.AgentEventRecord) { delete(record.Data, field) })
		}
		for _, field := range []string{"unknown_field", "runtime_execution_id", "mcp_endpoint"} {
			add(eventType+"/extra/"+field, eventType, func(record *ports.AgentEventRecord) { record.Data[field] = "private" })
		}
		for _, field := range []string{"organization_id", "agent_spec_revision_id", "execution_revision_id", "runtime_revision"} {
			for _, invalid := range []struct {
				name  string
				value any
			}{
				{name: "empty", value: ""}, {name: "space", value: "org 1"},
				{name: "slash", value: "org/1"}, {name: "leading punctuation", value: "_org"},
				{name: "non ASCII", value: "组织"}, {name: "too long", value: strings.Repeat("a", 201)},
				{name: "null", value: nil}, {name: "number", value: float64(1)}, {name: "boolean", value: true},
			} {
				add(eventType+"/"+field+"/"+invalid.name, eventType, func(record *ports.AgentEventRecord) {
					record.Data[field] = invalid.value
				})
			}
		}
		for _, field := range fields[4:] {
			for _, invalid := range []struct {
				name  string
				value any
			}{
				{name: "zero", value: float64(0)}, {name: "negative", value: float64(-1)},
				{name: "fraction", value: 1.5}, {name: "unsafe", value: float64(9007199254740992)},
				{name: "null", value: nil}, {name: "string", value: "8"}, {name: "boolean", value: true},
			} {
				add(eventType+"/"+field+"/"+invalid.name, eventType, func(record *ports.AgentEventRecord) {
					record.Data[field] = invalid.value
				})
			}
		}
	}
	add("runtime_bound/forbidden ACK", ports.EventRuntimeBound, func(record *ports.AgentEventRecord) {
		record.Data["applied_revision"] = float64(9)
	})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &agentEventStoreStub{events: []ports.AgentEventRecord{test.record}}
			service := NewEventService(store, store, &agentQueryStoreStub{})
			page, err := service.ListGlobalEvents(context.Background(), ListEventsInput{
				OrganizationID: "org-1", AfterSequence: 10,
			})
			if !errors.Is(err, ErrQueryContract) || len(page.Events) != 0 {
				t.Fatalf("invalid readiness event page=%+v error=%v", page, err)
			}
		})
	}
}

func TestReadinessEventsRetainEnvelopeValidation(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		mutate func([]ports.AgentEventRecord) []ports.AgentEventRecord
	}{
		{name: "event identity", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].EventID = "bad event"
			return records
		}},
		{name: "Agent identity", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].AgentID = "bad agent"
			return records
		}},
		{name: "foreign Agent", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].AgentID = "agent-2"
			return records
		}},
		{name: "operation identity", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].OperationRequestID = "bad operation"
			return records
		}},
		{name: "Trace identity", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].TraceID = "BAD-TRACE"
			return records
		}},
		{name: "timestamp", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].OccurredAt = time.Time{}
			return records
		}},
		{name: "aggregate sequence", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].AggregateSequence = 0
			return records
		}},
		{name: "cursor", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[0].GlobalSequence = 10
			return records
		}},
		{name: "duplicate sequence", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[1].GlobalSequence = 11
			return records
		}},
		{name: "backward sequence", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord {
			records[1].GlobalSequence = 9
			return records
		}},
		{name: "page limit", mutate: func(records []ports.AgentEventRecord) []ports.AgentEventRecord { return append(records, records[1]) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			records := []ports.AgentEventRecord{
				readinessReaderEvent(t, 11, ports.EventRuntimeBound),
				readinessReaderEvent(t, 12, ports.EventAgentReady),
			}
			err := validateEventRecords(test.mutate(records), ports.AgentEventQuery{
				OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: 10, Limit: 2,
			})
			if !errors.Is(err, ErrQueryContract) {
				t.Fatalf("invalid v2 envelope error = %v", err)
			}
		})
	}
}

func TestWatchAgentEventsRejectsMalformedReadinessPageBeforeAnyEmit(t *testing.T) {
	t.Parallel()

	for _, perAgent := range []bool{false, true} {
		for _, eventType := range []string{ports.EventRuntimeBound, ports.EventAgentReady} {
			t.Run(strconv.FormatBool(perAgent)+"/"+eventType, func(t *testing.T) {
				t.Parallel()
				invalid := readinessReaderEvent(t, 13, eventType)
				if eventType == ports.EventRuntimeBound {
					invalid.Data["unknown_field"] = true
				} else {
					delete(invalid.Data, "applied_revision")
				}
				store := &agentEventStoreStub{events: []ports.AgentEventRecord{
					testAgentEvent(11, "event-legacy", "agent-1", 1),
					readinessReaderEvent(t, 12, ports.EventRuntimeBound), invalid,
				}}
				service := NewEventService(store, store, &agentQueryStoreStub{
					record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC()),
				})
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				emitted := 0
				emit := func(AgentEventView) error { emitted++; return nil }
				var err error
				if perAgent {
					err = service.WatchAgentEvents(ctx, "org-1", "agent-1", 10, emit)
				} else {
					err = service.WatchGlobalEvents(ctx, "org-1", 10, emit)
				}
				if !errors.Is(err, ErrQueryContract) || emitted != 0 || store.listCalls != 1 || store.subscribeCalls != 1 {
					t.Fatalf("watch error=%v emitted=%d lists=%d subscriptions=%d", err, emitted, store.listCalls, store.subscribeCalls)
				}
			})
		}
	}
}

func TestReadinessProofDoesNotAuthorizeCrossOrganizationAgentEvents(t *testing.T) {
	t.Parallel()

	record := readinessReaderEvent(t, 11, ports.EventAgentReady)
	record.Data["organization_id"] = "org-2"
	store := &agentEventStoreStub{events: []ports.AgentEventRecord{record}}
	service := NewEventService(store, store, &agentQueryStoreStub{
		record: queryAgentRecord("agent-1", "user-1", "available", time.Unix(1, 0).UTC()),
	})
	_, err := service.ListAgentEvents(context.Background(), ListAgentEventsInput{
		OrganizationID: "org-2", AgentID: "agent-1", AfterSequence: 10,
	})
	if !errors.Is(err, ErrAgentNotFound) || store.listCalls != 0 {
		t.Fatalf("cross-organization v2 list error=%v lists=%d", err, store.listCalls)
	}
	emitted := 0
	err = service.WatchAgentEvents(context.Background(), "org-2", "agent-1", 10, func(AgentEventView) error {
		emitted++
		return nil
	})
	if !errors.Is(err, ErrAgentNotFound) || emitted != 0 || store.listCalls != 0 || store.subscribeCalls != 0 {
		t.Fatalf("cross-organization v2 watch error=%v emitted=%d lists=%d subscriptions=%d", err, emitted, store.listCalls, store.subscribeCalls)
	}
}

func legacyReadinessReaderEventTypes() []string {
	return []string{
		ports.EventAgentCreateRequested, ports.EventAgentCreated, ports.EventAgentReady,
		ports.EventAgentBuildFailed, ports.EventAgentRebuildRequested, ports.EventAgentRebuilt,
		ports.EventAgentDisableRequested, ports.EventAgentDisabled, ports.EventAgentDisableFailed,
		ports.EventAgentEnableRequested, ports.EventAgentEnabled, ports.EventAgentEnableFailed,
		ports.EventAgentDeleteRequested, ports.EventAgentDeleted, ports.EventAgentLifecycleQuarantined,
		ports.EventAgentRuntimeRestarted, ports.EventAgentRuntimeMissing, ports.EventAgentRuntimeConditionChanged,
		ports.EventAgentOwnerRevoked, ports.EventAgentAuthorizationUpdated,
	}
}

func readinessReaderEvent(t *testing.T, sequence int64, eventType string) ports.AgentEventRecord {
	t.Helper()
	// PostgreSQL scanAgentEvent uses the same JSON decoder for persisted event data.
	var data map[string]any
	if err := json.Unmarshal([]byte(`{"organization_id":"org-1","agent_spec_revision_id":"spec-1","execution_revision_id":"execution-1","runtime_revision":"runtime-1","ready_after_revision":8}`), &data); err != nil {
		t.Fatalf("decode synthetic readiness proof: %v", err)
	}
	if eventType == ports.EventAgentReady {
		data["applied_revision"] = float64(9)
	}
	record := testAgentEvent(sequence, "event-"+strconv.FormatInt(sequence, 10), "agent-1", sequence-8)
	record.SchemaVersion = 2
	record.EventType = eventType
	record.OperationRequestID = "create-1"
	record.TraceID = "0123456789abcdef0123456789abcdef"
	record.Data = data
	return record
}

func mixedReadinessReaderEvents(t *testing.T) []ports.AgentEventRecord {
	t.Helper()
	legacy := testAgentEvent(11, "event-legacy", "agent-1", 3)
	legacy.Data = map[string]any{}
	other := readinessReaderEvent(t, 14, ports.EventRuntimeBound)
	other.AgentID = "agent-2"
	other.AggregateSequence = 1
	return []ports.AgentEventRecord{
		legacy, readinessReaderEvent(t, 13, ports.EventRuntimeBound), other,
		readinessReaderEvent(t, 17, ports.EventAgentReady),
	}
}

func assertReadinessReaderEvent(t *testing.T, got AgentEventView, want ports.AgentEventRecord) {
	t.Helper()
	if got.EventID != want.EventID || got.GlobalSequence != want.GlobalSequence ||
		got.AggregateSequence != want.AggregateSequence || got.SchemaVersion != want.SchemaVersion ||
		got.AgentID != want.AgentID || got.EventType != want.EventType ||
		got.OperationRequestID != want.OperationRequestID || got.TraceID != want.TraceID ||
		!got.OccurredAt.Equal(want.OccurredAt) || !reflect.DeepEqual(got.Data, want.Data) {
		t.Fatalf("read event=%+v want=%+v", got, want)
	}
}
