package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
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
	handler, err := NewHandler(
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
