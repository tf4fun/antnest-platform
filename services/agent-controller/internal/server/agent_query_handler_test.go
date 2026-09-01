package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
)

func TestAgentQueryHandlerGetsKnownDeletedProjection(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	queries := &agentQueryServiceStub{agent: application.AgentView{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Deleted Agent", DesiredState: domain.DesiredDeleted,
		LifecycleState: domain.AgentDeleted, AccessRevision: "access-1",
		AggregateSequence: 12, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || queries.agentID != "agent-1" {
		t.Fatalf("status=%d agent_id=%q body=%s", response.Code, queries.agentID, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	var payload struct {
		AgentID           string `json:"agent_id"`
		OwnerUserID       string `json:"owner_user_id"`
		AggregateSequence int64  `json:"aggregate_sequence"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode Agent: %v", err)
	}
	if payload.AgentID != "agent-1" || payload.OwnerUserID != "user-1" || payload.AggregateSequence != 12 {
		t.Fatalf("Agent response = %+v", payload)
	}
}

func TestAgentQueryHandlerOmitsNonExecutableRuntimeRevision(t *testing.T) {
	t.Parallel()

	queries := &agentQueryServiceStub{agent: application.AgentView{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Disabled Agent", DesiredState: domain.DesiredDisabled,
		LifecycleState: domain.AgentDisabled, AccessRevision: "access-1",
		RuntimeRevision: "retained-runtime-revision", AggregateSequence: 5,
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode Agent: %v", err)
	}
	if _, present := payload["runtime"]; present {
		t.Fatalf("disabled Agent exposed a non-executable Runtime binding: %+v", payload["runtime"])
	}
}

func TestAgentQueryHandlerRejectsQueryOnExactGet(t *testing.T) {
	t.Parallel()

	queries := &agentQueryServiceStub{}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1?include_deleted=false", nil),
	)
	if response.Code != http.StatusBadRequest || queries.agentID != "" {
		t.Fatalf("status=%d queried=%q body=%s", response.Code, queries.agentID, response.Body.String())
	}
}

func TestAgentQueryHandlerListsWithStrictFilters(t *testing.T) {
	t.Parallel()

	queries := &agentQueryServiceStub{page: application.AgentPage{
		Items: []application.AgentView{{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Agent", DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentAvailable, AccessRevision: "access-1",
			AggregateSequence: 4, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
		}},
		NextCursor: "next-cursor",
	}}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodGet,
		"/internal/agents?organization_id=org-1&owner_user_id=user-1&lifecycle_state=available&include_deleted=true&limit=25&cursor=cursor-1",
		nil,
	)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	expected := application.ListAgentsInput{
		OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentAvailable, IncludeDeleted: true,
		Limit: 25, Cursor: "cursor-1",
	}
	if queries.listInput != expected {
		t.Fatalf("list input=%+v expected=%+v", queries.listInput, expected)
	}
	var payload struct {
		Items      []agentResponse `json:"items"`
		NextCursor *string         `json:"next_cursor"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode Agent list: %v", err)
	}
	if len(payload.Items) != 1 || payload.Items[0].AggregateSequence != 4 ||
		payload.NextCursor == nil || *payload.NextCursor != "next-cursor" {
		t.Fatalf("Agent page = %+v", payload)
	}
}

func TestAgentQueryHandlerRejectsAmbiguousOrUnknownQuery(t *testing.T) {
	t.Parallel()

	tests := []string{
		"/internal/agents?unknown=value",
		"/internal/agents?include_deleted=yes",
		"/internal/agents?include_deleted=",
		"/internal/agents?limit=zero",
		"/internal/agents?organization_id=",
		"/internal/agents?owner_user_id=",
		"/internal/agents?lifecycle_state=",
		"/internal/agents?cursor=",
		"/internal/agents?organization_id=org-a;bad=1",
		"/internal/agents?owner_user_id=user-1&owner_user_id=user-2",
	}
	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			queries := &agentQueryServiceStub{}
			handler, err := NewHandler(
				&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
				&agentEventServiceStub{},
				func(context.Context) error { return nil },
			)
			if err != nil {
				t.Fatalf("new handler: %v", err)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusBadRequest || queries.listCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, queries.listCalls, response.Body.String())
			}
		})
	}
}

func TestAgentQueryHandlerMapsServiceError(t *testing.T) {
	t.Parallel()

	queries := &agentQueryServiceStub{err: application.ErrAgentNotFound}
	handler, err := NewHandler(
		&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{},
		func(context.Context) error { return nil },
	)
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-missing", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var payload errorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if payload.Code != "agent_not_found" || errors.Is(queries.err, nil) {
		t.Fatalf("error response=%+v", payload)
	}
}

type agentQueryServiceStub struct {
	agent     application.AgentView
	page      application.AgentPage
	err       error
	agentID   string
	listInput application.ListAgentsInput
	listCalls int
}

func (service *agentQueryServiceStub) GetAgent(
	_ context.Context, agentID string,
) (application.AgentView, error) {
	service.agentID = agentID
	return service.agent, service.err
}

func (service *agentQueryServiceStub) ListAgents(
	_ context.Context, input application.ListAgentsInput,
) (application.AgentPage, error) {
	service.listCalls++
	service.listInput = input
	return service.page, service.err
}
