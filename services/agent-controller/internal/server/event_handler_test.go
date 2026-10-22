package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

func TestEventHandlerListsGlobalAndPerAgentJournal(t *testing.T) {
	t.Parallel()

	events := &agentEventServiceStub{page: application.AgentEventPage{
		Events:       []application.AgentEventView{serverTestEvent(11, "event-11", "agent-1")},
		NextSequence: 11,
	}}
	handler := newEventTestHandler(t, events)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "/internal/agent-events?organization_id=org-1&after_sequence=10&limit=25", nil,
	))
	if response.Code != http.StatusOK || events.globalInput != (application.ListEventsInput{
		OrganizationID: "org-1", AfterSequence: 10, Limit: 25,
	}) {
		t.Fatalf("global status=%d input=%+v body=%s", response.Code, events.globalInput, response.Body.String())
	}
	var payload struct {
		Events       []agentEventResponse `json:"events"`
		NextSequence int64                `json:"next_sequence"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode global event page: %v", err)
	}
	if len(payload.Events) != 1 || payload.Events[0].GlobalSequence != 11 || payload.NextSequence != 11 {
		t.Fatalf("global event page = %+v", payload)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "/internal/agents/agent-1/events?organization_id=org-1&after_sequence=8", nil,
	))
	if response.Code != http.StatusOK || events.agentInput.OrganizationID != "org-1" ||
		events.agentInput.AgentID != "agent-1" ||
		events.agentInput.AfterSequence != 8 {
		t.Fatalf("per-Agent status=%d input=%+v body=%s", response.Code, events.agentInput, response.Body.String())
	}
}

func TestEventHandlerRejectsMalformedAmbiguousOrEmptyQuery(t *testing.T) {
	t.Parallel()

	targets := []string{
		"/internal/agent-events?unknown=1",
		"/internal/agent-events?after_sequence=",
		"/internal/agent-events?after_sequence=-1",
		"/internal/agent-events?after_sequence=one",
		"/internal/agent-events?after_sequence=1&after_sequence=2",
		"/internal/agent-events?limit=0",
		"/internal/agent-events?limit=1;bad=2",
	}
	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			events := &agentEventServiceStub{}
			handler := newEventTestHandler(t, events)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusBadRequest || events.listCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, events.listCalls, response.Body.String())
			}
		})
	}
}

func TestEventHandlerStreamsBacklogAndContinuesFromLastSequence(t *testing.T) {
	t.Parallel()

	events := &agentEventServiceStub{
		page: application.AgentEventPage{
			Events:       []application.AgentEventView{serverTestEvent(11, "event-11", "agent-1")},
			NextSequence: 11,
		},
		watchEvents: []application.AgentEventView{serverTestEvent(12, "event-12", "agent-1")},
	}
	handler := newEventTestHandler(t, events)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet, "/internal/agent-events/watch?organization_id=org-1", nil,
	)
	request.Header.Set("Last-Event-ID", "10")
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("watch status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	if events.globalInput.AfterSequence != 10 || events.watchAfterSequence != 11 {
		t.Fatalf("watch inputs preflight=%+v after=%d", events.globalInput, events.watchAfterSequence)
	}
	body := response.Body.String()
	for _, fragment := range []string{
		"id: 11\nevent: agent_event\ndata:",
		"\n\nid: 12\nevent: agent_event\ndata:",
		`"event_id":"event-12"`,
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("SSE body lacks %q: %s", fragment, body)
		}
	}
}

func TestEventHandlerPrefersLastEventIDOnAutomaticReconnect(t *testing.T) {
	t.Parallel()

	events := &agentEventServiceStub{page: application.AgentEventPage{NextSequence: 10}}
	handler := newEventTestHandler(t, events)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet, "/internal/agent-events/watch?organization_id=org-1&after_sequence=9", nil,
	)
	request.Header.Set("Last-Event-ID", "10")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || events.globalInput.AfterSequence != 10 ||
		events.watchAfterSequence != 10 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, events.listCalls, response.Body.String())
	}
}

func TestEventHandlerStreamsThroughProductionTelemetryWrapper(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		target string
	}{
		{name: "global", target: "/internal/agent-events/watch?organization_id=org-1"},
		{name: "per Agent", target: "/internal/agents/agent-1/events/watch?organization_id=org-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			events := &agentEventServiceStub{
				page: application.AgentEventPage{
					Events:       []application.AgentEventView{serverTestEvent(1, "event-1", "agent-1")},
					NextSequence: 1,
				},
			}
			handler := telemetry.HTTPHandler(
				newEventTestHandler(t, events),
				slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
			)
			response := &deadlineResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.target, nil))
			if response.Code != http.StatusOK ||
				response.Header().Get("Content-Type") != "text/event-stream" ||
				!strings.Contains(response.Body.String(), "id: 1\nevent: agent_event") {
				t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
			}
			if !response.writeDeadlineCleared {
				t.Fatal("SSE handler did not clear the server write deadline")
			}
		})
	}
}

type deadlineResponseRecorder struct {
	*httptest.ResponseRecorder
	writeDeadlineCleared bool
}

func (response *deadlineResponseRecorder) SetWriteDeadline(deadline time.Time) error {
	response.writeDeadlineCleared = deadline.IsZero()
	return nil
}

func newEventTestHandler(t *testing.T, events AgentEventService) http.Handler {
	t.Helper()
	handler, err := newBusinessHandler(t,
		&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{},
		&agentQueryServiceStub{}, events, &networkPolicyServiceStub{},

		func(context.Context) error { return nil })

	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	return handler
}

func serverTestEvent(sequence int64, eventID string, agentID string) application.AgentEventView {
	return application.AgentEventView{
		EventID: eventID, GlobalSequence: sequence, AggregateSequence: sequence,
		SchemaVersion: 1, AgentID: agentID, EventType: ports.EventAgentReady,
		TraceID:    "0123456789abcdef0123456789abcdef",
		OccurredAt: time.Unix(sequence, 0).UTC(), Data: map[string]any{"result": "ok"},
	}
}

type agentEventServiceStub struct {
	page                application.AgentEventPage
	err                 error
	globalInput         application.ListEventsInput
	agentInput          application.ListAgentEventsInput
	watchAgentID        string
	watchOrganizationID string
	watchAfterSequence  int64
	watchEvents         []application.AgentEventView
	listCalls           int
}

func (service *agentEventServiceStub) ListGlobalEvents(
	_ context.Context, input application.ListEventsInput,
) (application.AgentEventPage, error) {
	service.listCalls++
	service.globalInput = input
	return service.page, service.err
}

func (service *agentEventServiceStub) ListAgentEvents(
	_ context.Context, input application.ListAgentEventsInput,
) (application.AgentEventPage, error) {
	service.listCalls++
	service.agentInput = input
	return service.page, service.err
}

func (service *agentEventServiceStub) WatchGlobalEvents(
	_ context.Context, organizationID string, afterSequence int64, emit application.AgentEventEmitter,
) error {
	service.watchOrganizationID = organizationID
	service.watchAfterSequence = afterSequence
	for _, event := range service.watchEvents {
		if err := emit(event); err != nil {
			return err
		}
	}
	return service.err
}

func (service *agentEventServiceStub) WatchAgentEvents(
	_ context.Context, organizationID string, agentID string, afterSequence int64,
	emit application.AgentEventEmitter,
) error {
	service.watchOrganizationID = organizationID
	service.watchAgentID = agentID
	return service.WatchGlobalEvents(context.Background(), organizationID, afterSequence, emit)
}

func TestEventHandlerListsMixedReadinessVersionsWithoutChangingProof(t *testing.T) {
	t.Parallel()

	for _, perAgent := range []bool{false, true} {
		t.Run(strconv.FormatBool(perAgent), func(t *testing.T) {
			t.Parallel()
			wanted := serverReadinessReaderEvents()
			events := &agentEventServiceStub{page: application.AgentEventPage{
				Events: wanted, NextSequence: 17,
			}}
			target := "/internal/agent-events?organization_id=org-1&after_sequence=10&limit=25"
			if perAgent {
				target = "/internal/agents/agent-1/events?organization_id=org-1&after_sequence=10&limit=25"
			}
			response := httptest.NewRecorder()
			newEventTestHandler(t, events).ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusOK || events.listCalls != 1 {
				t.Fatalf("mixed-version list status=%d calls=%d", response.Code, events.listCalls)
			}
			if perAgent {
				if events.agentInput != (application.ListAgentEventsInput{
					OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: 10, Limit: 25,
				}) {
					t.Fatalf("per-Agent mixed-version query = %+v", events.agentInput)
				}
			} else if events.globalInput != (application.ListEventsInput{
				OrganizationID: "org-1", AfterSequence: 10, Limit: 25,
			}) {
				t.Fatalf("global mixed-version query = %+v", events.globalInput)
			}
			var payload struct {
				Events       []json.RawMessage `json:"events"`
				NextSequence int64             `json:"next_sequence"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode mixed-version event page: %v", err)
			}
			if len(payload.Events) != len(wanted) || payload.NextSequence != 17 {
				t.Fatalf("mixed-version list count=%d cursor=%d", len(payload.Events), payload.NextSequence)
			}
			for index, event := range payload.Events {
				assertReadinessWireEvent(t, event, wanted[index])
			}
		})
	}
}

func TestEventHandlerStreamsMixedReadinessVersionsThroughTelemetry(t *testing.T) {
	t.Parallel()

	for _, perAgent := range []bool{false, true} {
		t.Run(strconv.FormatBool(perAgent), func(t *testing.T) {
			t.Parallel()
			wanted := serverReadinessReaderEvents()
			events := &agentEventServiceStub{
				page:        application.AgentEventPage{Events: wanted[:2], NextSequence: 13},
				watchEvents: wanted[2:],
			}
			handler := telemetry.HTTPHandler(
				newEventTestHandler(t, events),
				slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
			)
			target := "/internal/agent-events/watch?organization_id=org-1&after_sequence=9"
			if perAgent {
				target = "/internal/agents/agent-1/events/watch?organization_id=org-1&after_sequence=9"
			}
			request := httptest.NewRequest(http.MethodGet, target, nil)
			request.Header.Set("Last-Event-ID", "10")
			response := &deadlineResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" ||
				response.Header().Get("Cache-Control") != "no-cache, no-store" || !response.writeDeadlineCleared {
				t.Fatalf("mixed-version SSE status=%d headers=%v deadline_cleared=%t", response.Code, response.Header(), response.writeDeadlineCleared)
			}
			if events.listCalls != 1 || events.watchOrganizationID != "org-1" || events.watchAfterSequence != 13 {
				t.Fatalf("SSE lists=%d organization=%q cursor=%d", events.listCalls, events.watchOrganizationID, events.watchAfterSequence)
			}
			if perAgent {
				if events.agentInput != (application.ListAgentEventsInput{
					OrganizationID: "org-1", AgentID: "agent-1", AfterSequence: 10,
				}) || events.watchAgentID != "agent-1" {
					t.Fatalf("per-Agent SSE input=%+v watch_Agent=%q", events.agentInput, events.watchAgentID)
				}
			} else if events.globalInput != (application.ListEventsInput{
				OrganizationID: "org-1", AfterSequence: 10,
			}) || events.watchAgentID != "" {
				t.Fatalf("global SSE input=%+v watch_Agent=%q", events.globalInput, events.watchAgentID)
			}
			frames := strings.Split(strings.TrimSuffix(response.Body.String(), "\n\n"), "\n\n")
			if len(frames) != len(wanted) {
				t.Fatalf("mixed-version SSE frames=%d want=%d", len(frames), len(wanted))
			}
			for index, frame := range frames {
				lines := strings.Split(frame, "\n")
				if len(lines) != 3 || lines[0] != "id: "+strconv.FormatInt(wanted[index].GlobalSequence, 10) ||
					lines[1] != "event: agent_event" || !strings.HasPrefix(lines[2], "data: ") {
					t.Fatalf("mixed-version SSE frame %d has invalid framing", index)
				}
				assertReadinessWireEvent(t, []byte(strings.TrimPrefix(lines[2], "data: ")), wanted[index])
			}
		})
	}
}

func serverReadinessReaderEvents() []application.AgentEventView {
	legacy := serverTestEvent(11, "event-legacy", "agent-1")
	legacy.AggregateSequence = 3
	legacy.Data = map[string]any{}
	bound := serverTestEvent(13, "event-bound", "agent-1")
	bound.AggregateSequence = 4
	bound.SchemaVersion = 2
	bound.EventType = ports.EventRuntimeBound
	bound.OperationRequestID = "create-1"
	bound.Data = map[string]any{
		"organization_id": "org-1", "agent_spec_revision_id": "spec-1",
		"execution_revision_id": "execution-1", "runtime_revision": "runtime-1",
		"ready_after_revision": float64(8),
	}
	ready := serverTestEvent(17, "event-ready", "agent-1")
	ready.AggregateSequence = 5
	ready.SchemaVersion = 2
	ready.OperationRequestID = "create-1"
	ready.Data = map[string]any{
		"organization_id": "org-1", "agent_spec_revision_id": "spec-1",
		"execution_revision_id": "execution-1", "runtime_revision": "runtime-1",
		"ready_after_revision": float64(8), "applied_revision": float64(9),
	}
	return []application.AgentEventView{legacy, bound, ready}
}

func assertReadinessWireEvent(t *testing.T, raw []byte, want application.AgentEventView) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode readiness event wire: %v", err)
	}
	expected := map[string]any{
		"event_id": want.EventID, "global_sequence": float64(want.GlobalSequence),
		"aggregate_sequence": float64(want.AggregateSequence), "schema_version": float64(want.SchemaVersion),
		"agent_id": want.AgentID, "event_type": want.EventType,
		"occurred_at": want.OccurredAt.Format(time.RFC3339Nano), "data": want.Data,
	}
	if want.OperationRequestID != "" {
		expected["operation_request_id"] = want.OperationRequestID
	}
	if want.TraceID != "" {
		expected["trace_id"] = want.TraceID
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("readiness event wire=%+v want=%+v", got, expected)
	}
}
