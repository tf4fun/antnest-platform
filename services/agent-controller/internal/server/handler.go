package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

const maximumRequestBytes = 2 << 20

var (
	serverMeter         = otel.Meter("github.com/tf4fun/antnest-platform/agent-controller/server")
	lifecycleOperations = mustLifecycleCounter(
		serverMeter.Int64Counter(
			"antnest.agent_controller.lifecycle.operations",
			metric.WithDescription("Agent lifecycle request outcomes"),
		),
	)
	eventWatchConnections = mustEventWatchConnections(
		serverMeter.Int64UpDownCounter(
			"antnest.agent_controller.event_watch.connections",
			metric.WithDescription("Current Agent event watch connections"),
		),
	)
	eventWatchDisconnects = mustLifecycleCounter(
		serverMeter.Int64Counter(
			"antnest.agent_controller.event_watch.disconnects",
			metric.WithDescription("Agent event watch termination outcomes"),
		),
	)
)

type CatalogService interface {
	ProviderService
	SetCatalogAvailability(context.Context, application.SetCatalogAvailabilityInput) (ports.CatalogAvailability, error)
	CreateModelProfile(context.Context, application.CreateModelProfileInput) (application.ModelProfileView, error)
	ReviseModelProfile(context.Context, application.ReviseModelProfileInput) (application.ModelProfileView, error)
	GetModelProfile(context.Context, string, string) (application.ModelProfileView, error)
	ListModelProfiles(context.Context, application.ListCatalogInput) (application.ModelProfilePage, error)
	CreateTemplate(context.Context, application.CreateTemplateInput) (application.TemplateView, error)
	ReviseTemplate(context.Context, application.ReviseTemplateInput) (application.TemplateView, error)
	GetTemplate(context.Context, string, string) (application.TemplateView, error)
	GetTemplateRevision(context.Context, string, string, int64) (application.TemplateView, error)
	ListTemplates(context.Context, application.ListCatalogInput) (application.TemplatePage, error)
}

type LifecycleService interface {
	CreateAgent(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error)
	RebuildAgent(context.Context, application.RebuildAgentInput) (application.RebuildAgentResult, error)
	DisableAgent(context.Context, application.DisableAgentInput) (application.DisableAgentResult, error)
	EnableAgent(context.Context, application.EnableAgentInput) (application.EnableAgentResult, error)
	DeleteAgent(context.Context, application.DeleteAgentInput) (application.DeleteAgentResult, error)
	GetLifecycleOperation(context.Context, string) (application.OperationView, error)
	GetSkillPreparationStatus(context.Context, string, string) (application.SkillPreparationStatus, error)
}

type AgentConfigurationService interface {
	SetAgentAuthorization(context.Context, application.SetAgentAuthorizationInput) (int64, error)
	GetExecutionSynchronization(context.Context, string) (application.ExecutionSynchronizationView, error)
}

type AgentQueryService interface {
	GetAgent(context.Context, string) (application.AgentView, error)
	GetAgentForOrganization(context.Context, string, string) (application.AgentView, error)
	ListAgents(context.Context, application.ListAgentsInput) (application.AgentPage, error)
	ListWorkspaceAgents(context.Context, application.ListWorkspaceAgentsInput) (application.WorkspaceAgentPage, error)
}

type AgentEventService interface {
	ListGlobalEvents(context.Context, application.ListEventsInput) (application.AgentEventPage, error)
	ListAgentEvents(context.Context, application.ListAgentEventsInput) (application.AgentEventPage, error)
	WatchGlobalEvents(context.Context, string, int64, application.AgentEventEmitter) error
	WatchAgentEvents(context.Context, string, string, int64, application.AgentEventEmitter) error
}

type HealthCheck func(context.Context) error

type handler struct {
	catalog       CatalogService
	lifecycle     LifecycleService
	configuration AgentConfigurationService
	queries       AgentQueryService
	events        AgentEventService
	network       NetworkPolicyService
	health        HealthCheck
}

type routeDefinition struct {
	pattern      string
	handler      http.HandlerFunc
	metadataOnly bool
}

func NewHandler(
	catalog CatalogService, lifecycle LifecycleService, configuration AgentConfigurationService,
	queries AgentQueryService, events AgentEventService, network NetworkPolicyService,
	health HealthCheck,
) (http.Handler, error) {
	if catalog == nil {
		return nil, fmt.Errorf("catalog service is required")
	}
	if lifecycle == nil {
		return nil, fmt.Errorf("lifecycle service is required")
	}
	if configuration == nil {
		return nil, fmt.Errorf("agent configuration service is required")
	}
	if queries == nil {
		return nil, fmt.Errorf("agent query service is required")
	}
	if events == nil {
		return nil, fmt.Errorf("agent event service is required")
	}
	if health == nil {
		return nil, fmt.Errorf("health check is required")
	}
	if network == nil {
		return nil, fmt.Errorf("network policy service is required")
	}
	h := &handler{
		catalog: catalog, lifecycle: lifecycle, configuration: configuration, queries: queries, events: events, network: network, health: health,
	}
	mux := http.NewServeMux()
	for _, route := range h.routes() {
		var endpoint http.Handler = route.handler
		if !route.metadataOnly {
			endpoint = telemetry.RPCHandler(route.pattern, endpoint)
		}
		mux.Handle(route.pattern, endpoint)
	}
	return mux, nil
}

func (h *handler) routes() []routeDefinition {
	return []routeDefinition{
		{pattern: "GET /status", handler: h.status, metadataOnly: true},
		{pattern: "GET /rpc/agent-controller/status", handler: h.status, metadataOnly: true},
		{pattern: "POST /rpc/agent-controller/list-workspace-agents", handler: h.listWorkspaceAgents},
		{pattern: "POST /rpc/agent-controller/set-agent-authorization", handler: h.setAgentAuthorization},
		{pattern: "GET /internal/execution-synchronization", handler: h.getExecutionSynchronization},
		{pattern: "POST /internal/provider-connections", handler: h.createProviderConnection, metadataOnly: true},
		{pattern: "PUT /internal/provider-connections/{connection_id}/availability", handler: h.setProviderAvailability},
		{pattern: "PUT /internal/model-profiles/{model_profile_id}/availability", handler: h.setModelAvailability},
		{pattern: "PUT /internal/agent-templates/{template_id}/availability", handler: h.setTemplateAvailability},
		{pattern: "GET /internal/provider-connections", handler: h.listProviderConnections},
		{pattern: "GET /internal/provider-connections/{connection_id}", handler: h.getProviderConnection},
		{pattern: "GET /internal/provider-connections/{connection_id}/access", handler: h.resolveProviderAccess, metadataOnly: true},
		{pattern: "POST /internal/provider-connections/{connection_id}/credentials", handler: h.rotateProviderCredential, metadataOnly: true},
		{pattern: "POST /internal/model-profiles", handler: h.createModelProfile},
		{pattern: "GET /internal/model-profiles", handler: h.listModelProfiles},
		{pattern: "GET /internal/model-profiles/{model_profile_id}", handler: h.getModelProfile},
		{pattern: "POST /internal/model-profiles/{model_profile_id}/revisions", handler: h.reviseModelProfile},
		{pattern: "POST /internal/agent-templates", handler: h.createTemplate},
		{pattern: "GET /internal/agent-templates", handler: h.listTemplates},
		{pattern: "GET /internal/agent-templates/{template_id}", handler: h.getTemplate},
		{pattern: "GET /internal/agent-templates/{template_id}/revisions/{revision}", handler: h.getTemplateRevision},
		{pattern: "POST /internal/agent-templates/{template_id}/revisions", handler: h.reviseTemplate},
		{pattern: "POST /internal/agents", handler: h.createAgent},
		{pattern: "GET /internal/agents", handler: h.listAgents},
		{pattern: "GET /internal/agents/{agent_id}", handler: h.getAgent},
		{pattern: "GET /internal/agents/{agent_id}/network-policy", handler: h.getAgentNetworkPolicy},
		{pattern: "PUT /internal/agents/{agent_id}/network-policy", handler: h.setAgentNetworkPolicy},
		{pattern: "POST /internal/agents/{agent_id}/rebuild", handler: h.rebuildAgent},
		{pattern: "POST /internal/agents/{agent_id}/disable", handler: h.disableAgent},
		{pattern: "POST /internal/agents/{agent_id}/enable", handler: h.enableAgent},
		{pattern: "POST /internal/agents/{agent_id}/delete", handler: h.deleteAgent},
		{pattern: "GET /internal/agent-operations/{request_id}", handler: h.getLifecycleOperation},
		{pattern: "GET /internal/agent-skill-preparations/{request_id}", handler: h.getSkillPreparationStatus},
		{pattern: "GET /internal/agent-events", handler: h.listGlobalAgentEvents},
		{pattern: "GET /internal/agent-events/watch", handler: h.watchGlobalAgentEvents, metadataOnly: true},
		{pattern: "GET /internal/agents/{agent_id}/events", handler: h.listAgentEvents},
		{pattern: "GET /internal/agents/{agent_id}/events/watch", handler: h.watchAgentEvents, metadataOnly: true},
	}
}

type createModelProfileRequest struct {
	RequestID            string                 `json:"request_id"`
	OrganizationID       string                 `json:"organization_id"`
	ProfileKey           string                 `json:"profile_key"`
	DisplayName          string                 `json:"display_name"`
	Model                domain.ModelParameters `json:"model"`
	ProviderConnectionID string                 `json:"provider_connection_id"`
}

type reviseModelProfileRequest struct {
	ExpectedVersion int64                  `json:"expected_version"`
	RequestID       string                 `json:"request_id"`
	OrganizationID  string                 `json:"organization_id"`
	DisplayName     string                 `json:"display_name"`
	Model           domain.ModelParameters `json:"model"`
}

type createTemplateRequest struct {
	RequestID               string                  `json:"request_id"`
	OrganizationID          string                  `json:"organization_id"`
	TemplateKey             string                  `json:"template_key"`
	Name                    string                  `json:"name"`
	ModelProfileID          string                  `json:"model_profile_id"`
	FallbackModelProfileIDs []string                `json:"fallback_model_profile_ids,omitempty"`
	SystemPrompt            string                  `json:"system_prompt"`
	MaxModelRequests        int                     `json:"max_model_requests"`
	ContextPolicyVersion    string                  `json:"context_policy_version"`
	Runtime                 domain.RuntimeSpecInput `json:"runtime"`
	SkillRefs               []domain.SkillReference `json:"skill_refs,omitempty"`
}

type reviseTemplateRequest struct {
	RequestID               string                  `json:"request_id"`
	OrganizationID          string                  `json:"organization_id"`
	Name                    string                  `json:"name"`
	ModelProfileID          string                  `json:"model_profile_id"`
	FallbackModelProfileIDs []string                `json:"fallback_model_profile_ids,omitempty"`
	SystemPrompt            string                  `json:"system_prompt"`
	MaxModelRequests        int                     `json:"max_model_requests"`
	ContextPolicyVersion    string                  `json:"context_policy_version"`
	Runtime                 domain.RuntimeSpecInput `json:"runtime"`
	SkillRefs               []domain.SkillReference `json:"skill_refs,omitempty"`
}

type createAgentRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	OwnerUserID      string `json:"owner_user_id"`
	Name             string `json:"name"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

type rebuildAgentRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

type lifecycleRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
}

type listWorkspaceAgentsRequest struct {
	RequestID      string `json:"request_id"`
	OrganizationID string `json:"organization_id"`
	PrincipalID    string `json:"principal_id"`
	Limit          int    `json:"limit,omitempty"`
	Cursor         string `json:"cursor,omitempty"`
}

type modelProfileResponse struct {
	ProviderConnectionID string           `json:"provider_connection_id"`
	ModelProfileID       string           `json:"model_profile_id"`
	OrganizationID       string           `json:"organization_id"`
	ProfileKey           string           `json:"profile_key"`
	DisplayName          string           `json:"display_name"`
	RevisionID           string           `json:"revision_id"`
	Revision             int64            `json:"revision"`
	Enabled              bool             `json:"enabled"`
	Model                domain.ModelSpec `json:"model"`
	CreatedAt            time.Time        `json:"created_at"`
	UpdatedAt            time.Time        `json:"updated_at"`
}

type templateResponse struct {
	TemplateID              string                  `json:"template_id"`
	OrganizationID          string                  `json:"organization_id"`
	TemplateKey             string                  `json:"template_key"`
	Name                    string                  `json:"name"`
	Revision                int64                   `json:"revision"`
	ModelProfileID          string                  `json:"model_profile_id"`
	FallbackModelProfileIDs []string                `json:"fallback_model_profile_ids,omitempty"`
	SystemPrompt            string                  `json:"system_prompt"`
	MaxModelRequests        int                     `json:"max_model_requests"`
	ContextPolicyVersion    string                  `json:"context_policy_version"`
	Runtime                 domain.RuntimeSpecInput `json:"runtime"`
	SkillRefs               []domain.FrozenSkill    `json:"skill_refs"`
	SkillSetDigest          string                  `json:"skill_set_digest,omitempty"`
	Enabled                 bool                    `json:"enabled"`
	CreatedAt               time.Time               `json:"created_at"`
	UpdatedAt               time.Time               `json:"updated_at"`
}

type modelProfileListResponse struct {
	Items       []modelProfileResponse `json:"items"`
	NextAfterID *string                `json:"next_after_id"`
}

type templateListResponse struct {
	Items       []templateResponse `json:"items"`
	NextAfterID *string            `json:"next_after_id"`
}

type runtimeBindingResponse struct {
	RuntimeRevision    string `json:"runtime_revision"`
	RuntimeExecutionID string `json:"runtime_execution_id,omitempty"`
	MCPEndpoint        string `json:"mcp_endpoint,omitempty"`
}

type agentTemplateLineageResponse struct {
	TemplateID string `json:"template_id"`
	Revision   int64  `json:"revision"`
	Name       string `json:"name"`
}

type agentModelProfileLineageResponse struct {
	ModelProfileID string           `json:"model_profile_id"`
	RevisionID     string           `json:"revision_id"`
	Revision       int64            `json:"revision"`
	Name           string           `json:"name"`
	Model          domain.ModelSpec `json:"model"`
}

type agentConfigurationResponse struct {
	Template             agentTemplateLineageResponse     `json:"template"`
	ModelProfile         agentModelProfileLineageResponse `json:"model_profile"`
	MaxModelRequests     int                              `json:"max_model_requests"`
	ContextPolicyVersion string                           `json:"context_policy_version"`
	Runtime              domain.RuntimeSpecInput          `json:"runtime"`
	SystemSkills         []domain.FrozenSkill             `json:"system_skills"`
	SkillSetDigest       string                           `json:"skill_set_digest,omitempty"`
}

type agentResponse struct {
	ActivationState                 domain.ActivationState      `json:"activation_state,omitempty"`
	RuntimeState                    domain.RuntimeState         `json:"runtime_state"`
	RuntimeReason                   string                      `json:"runtime_reason,omitempty"`
	RuntimeDetail                   string                      `json:"runtime_detail,omitempty"`
	RuntimeObservedAt               *time.Time                  `json:"runtime_observed_at,omitempty"`
	AgentID                         string                      `json:"agent_id"`
	OrganizationID                  string                      `json:"organization_id"`
	OwnerUserID                     string                      `json:"owner_user_id"`
	Name                            string                      `json:"name"`
	DesiredState                    domain.DesiredState         `json:"desired_state"`
	LifecycleState                  domain.AgentState           `json:"lifecycle_state"`
	AccessRevision                  string                      `json:"access_revision"`
	AgentSpecRevision               string                      `json:"agent_spec_revision,omitempty"`
	ExecutableExecutionRevision     string                      `json:"executable_execution_revision,omitempty"`
	LastSuccessfulExecutionRevision string                      `json:"last_successful_execution_revision,omitempty"`
	Runtime                         *runtimeBindingResponse     `json:"runtime,omitempty"`
	ActiveOperationRequestID        string                      `json:"active_operation_request_id,omitempty"`
	FailureStage                    string                      `json:"failure_stage,omitempty"`
	FailureCode                     string                      `json:"failure_code,omitempty"`
	Configuration                   *agentConfigurationResponse `json:"configuration,omitempty"`
	AggregateSequence               int64                       `json:"aggregate_sequence"`
	CreatedAt                       time.Time                   `json:"created_at"`
	UpdatedAt                       time.Time                   `json:"updated_at"`
}

type agentListResponse struct {
	Items      []agentResponse `json:"items"`
	NextCursor *string         `json:"next_cursor"`
}

type agentEventResponse struct {
	EventID            string         `json:"event_id"`
	GlobalSequence     int64          `json:"global_sequence"`
	AggregateSequence  int64          `json:"aggregate_sequence"`
	SchemaVersion      int            `json:"schema_version"`
	AgentID            string         `json:"agent_id"`
	EventType          string         `json:"event_type"`
	OperationRequestID string         `json:"operation_request_id,omitempty"`
	TraceID            string         `json:"trace_id,omitempty"`
	OccurredAt         time.Time      `json:"occurred_at"`
	Data               map[string]any `json:"data"`
}

type agentEventListResponse struct {
	Events       []agentEventResponse `json:"events"`
	NextSequence int64                `json:"next_sequence"`
}

type operationResponse struct {
	RequestID   string                `json:"request_id"`
	AgentID     string                `json:"agent_id"`
	Kind        domain.OperationKind  `json:"kind"`
	Phase       domain.OperationPhase `json:"phase"`
	State       domain.OperationState `json:"state"`
	ErrorCode   string                `json:"error_code,omitempty"`
	ErrorDetail string                `json:"error_detail,omitempty"`
	CreatedAt   time.Time             `json:"created_at"`
	UpdatedAt   time.Time             `json:"updated_at"`
}

type createAgentResponse struct {
	Agent     agentResponse     `json:"agent"`
	Operation operationResponse `json:"operation"`
}

type workspaceAgentResponse struct {
	AgentID         string                 `json:"agent_id"`
	Name            string                 `json:"name"`
	LifecycleState  domain.AgentState      `json:"lifecycle_state"`
	ActivationState domain.ActivationState `json:"activation_state,omitempty"`
	RuntimeState    domain.RuntimeState    `json:"runtime_state"`
}

type workspaceAgentListResponse struct {
	Agents     []workspaceAgentResponse `json:"agents"`
	NextCursor *string                  `json:"next_cursor"`
}

type errorResponse struct {
	Code                string                   `json:"code"`
	Message             string                   `json:"message"`
	Retryable           bool                     `json:"retryable"`
	References          []ports.CatalogReference `json:"references,omitempty"`
	ReferencesTruncated bool                     `json:"references_truncated,omitempty"`
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	if err := h.health(request.Context()); err != nil {
		telemetry.RecordBoundaryError(request.Context(), err, "readiness", "internal_error", "local readiness check failed", true)
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) listWorkspaceAgents(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var payload listWorkspaceAgentsRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	page, err := h.queries.ListWorkspaceAgents(
		request.Context(), application.ListWorkspaceAgentsInput{
			RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
			PrincipalID: payload.PrincipalID, Limit: payload.Limit, Cursor: payload.Cursor,
		},
	)
	if err != nil {
		writeQueryError(request.Context(), response, err)
		return
	}
	agents := make([]workspaceAgentResponse, 0, len(page.Items))
	for _, item := range page.Items {
		agents = append(agents, workspaceAgentResponse{
			AgentID: item.AgentID, Name: item.Name,
			LifecycleState: item.LifecycleState, ActivationState: item.ActivationState, RuntimeState: item.RuntimeState,
		})
	}
	writeJSON(response, http.StatusOK, workspaceAgentListResponse{
		Agents: agents, NextCursor: optionalString(page.NextCursor),
	})
}

func (h *handler) createModelProfile(response http.ResponseWriter, request *http.Request) {
	var payload createModelProfileRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.CreateModelProfile(request.Context(), application.CreateModelProfileInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ProfileKey: payload.ProfileKey, DisplayName: payload.DisplayName,
		Model: payload.Model, ProviderConnectionID: payload.ProviderConnectionID,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, modelProfilePayload(view))
}

func (h *handler) reviseModelProfile(response http.ResponseWriter, request *http.Request) {
	var payload reviseModelProfileRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.ReviseModelProfile(request.Context(), application.ReviseModelProfileInput{
		ExpectedVersion: payload.ExpectedVersion,
		RequestID:       payload.RequestID, ModelProfileID: request.PathValue("model_profile_id"),
		OrganizationID: payload.OrganizationID,
		DisplayName:    payload.DisplayName, Model: payload.Model,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, modelProfilePayload(view))
}

func (h *handler) getModelProfile(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	view, err := h.catalog.GetModelProfile(
		request.Context(), organizationID, request.PathValue("model_profile_id"),
	)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, modelProfilePayload(view))
}

func (h *handler) listModelProfiles(response http.ResponseWriter, request *http.Request) {
	input, ok := catalogListInput(response, request)
	if !ok {
		return
	}
	page, err := h.catalog.ListModelProfiles(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	items := make([]modelProfileResponse, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, modelProfilePayload(item))
	}
	writeJSON(response, http.StatusOK, modelProfileListResponse{
		Items: items, NextAfterID: optionalString(page.NextAfterID),
	})
}

func (h *handler) createTemplate(response http.ResponseWriter, request *http.Request) {
	var payload createTemplateRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.CreateTemplate(request.Context(), application.CreateTemplateInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		TemplateKey: payload.TemplateKey, Name: payload.Name,
		ModelProfileID:          payload.ModelProfileID,
		FallbackModelProfileIDs: payload.FallbackModelProfileIDs,
		SystemPrompt:            payload.SystemPrompt, MaxModelRequests: payload.MaxModelRequests,
		ContextPolicyVersion: payload.ContextPolicyVersion, Runtime: payload.Runtime,
		SkillRefs: payload.SkillRefs,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, templatePayload(view))
}

func (h *handler) reviseTemplate(response http.ResponseWriter, request *http.Request) {
	var payload reviseTemplateRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	view, err := h.catalog.ReviseTemplate(request.Context(), application.ReviseTemplateInput{
		RequestID: payload.RequestID, TemplateID: request.PathValue("template_id"), Name: payload.Name,
		OrganizationID:          payload.OrganizationID,
		ModelProfileID:          payload.ModelProfileID,
		FallbackModelProfileIDs: payload.FallbackModelProfileIDs,
		SystemPrompt:            payload.SystemPrompt, MaxModelRequests: payload.MaxModelRequests,
		ContextPolicyVersion: payload.ContextPolicyVersion, Runtime: payload.Runtime,
		SkillRefs: payload.SkillRefs,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, templatePayload(view))
}

func (h *handler) getTemplate(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	view, err := h.catalog.GetTemplate(request.Context(), organizationID, request.PathValue("template_id"))
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, templatePayload(view))
}

func (h *handler) getTemplateRevision(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	revision, err := strconv.ParseInt(request.PathValue("revision"), 10, 64)
	if err != nil || revision < 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Template revision is invalid", false)
		return
	}
	view, err := h.catalog.GetTemplateRevision(
		request.Context(), organizationID, request.PathValue("template_id"), revision,
	)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, templatePayload(view))
}

func (h *handler) listTemplates(response http.ResponseWriter, request *http.Request) {
	input, ok := catalogListInput(response, request)
	if !ok {
		return
	}
	page, err := h.catalog.ListTemplates(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	items := make([]templateResponse, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, templatePayload(item))
	}
	writeJSON(response, http.StatusOK, templateListResponse{
		Items: items, NextAfterID: optionalString(page.NextAfterID),
	})
}

func (h *handler) createAgent(response http.ResponseWriter, request *http.Request) {
	var payload createAgentRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	ctx := request.Context()
	result, err := h.lifecycle.CreateAgent(ctx, application.CreateAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID,
		OwnerUserID:      payload.OwnerUserID, Name: payload.Name,
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, createAgentPayload(result))
}

func (h *handler) getAgent(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}})
	if !ok || strings.TrimSpace(query.Get("organization_id")) == "" {
		if ok {
			writeError(response, http.StatusBadRequest, "invalid_request", "organization is required", false)
		}
		return
	}
	if len(query) != 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return
	}
	agent, err := h.queries.GetAgentForOrganization(
		request.Context(), query.Get("organization_id"), request.PathValue("agent_id"),
	)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, agentPayload(agent))
}

func (h *handler) listAgents(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	input, ok := agentListInput(response, request)
	if !ok {
		return
	}
	page, err := h.queries.ListAgents(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	items := make([]agentResponse, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, agentPayload(item))
	}
	writeJSON(response, http.StatusOK, agentListResponse{
		Items: items, NextCursor: optionalString(page.NextCursor),
	})
}

func (h *handler) listGlobalAgentEvents(response http.ResponseWriter, request *http.Request) {
	input, ok := eventListInput(response, request)
	if !ok {
		return
	}
	page, err := h.events.ListGlobalEvents(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, agentEventListPayload(page))
}

func (h *handler) listAgentEvents(response http.ResponseWriter, request *http.Request) {
	input, ok := eventListInput(response, request)
	if !ok {
		return
	}
	page, err := h.events.ListAgentEvents(request.Context(), application.ListAgentEventsInput{
		OrganizationID: input.OrganizationID, AgentID: request.PathValue("agent_id"),
		AfterSequence: input.AfterSequence, Limit: input.Limit,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, agentEventListPayload(page))
}

func (h *handler) watchGlobalAgentEvents(response http.ResponseWriter, request *http.Request) {
	organizationID, afterSequence, ok := eventWatchInput(response, request)
	if !ok {
		return
	}
	page, err := h.events.ListGlobalEvents(request.Context(), application.ListEventsInput{
		OrganizationID: organizationID, AfterSequence: afterSequence,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	h.streamAgentEvents(response, request, "global", page, func(
		ctx context.Context, cursor int64, emit application.AgentEventEmitter,
	) error {
		return h.events.WatchGlobalEvents(ctx, organizationID, cursor, emit)
	})
}

func (h *handler) watchAgentEvents(response http.ResponseWriter, request *http.Request) {
	organizationID, afterSequence, ok := eventWatchInput(response, request)
	if !ok {
		return
	}
	agentID := request.PathValue("agent_id")
	page, err := h.events.ListAgentEvents(request.Context(), application.ListAgentEventsInput{
		OrganizationID: organizationID, AgentID: agentID, AfterSequence: afterSequence,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	h.streamAgentEvents(response, request, "agent", page, func(
		ctx context.Context, cursor int64, emit application.AgentEventEmitter,
	) error {
		return h.events.WatchAgentEvents(ctx, organizationID, agentID, cursor, emit)
	})
}

type watchAgentEvents func(context.Context, int64, application.AgentEventEmitter) error

func (h *handler) streamAgentEvents(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
	page application.AgentEventPage,
	watch watchAgentEvents,
) {
	ctx := request.Context()
	watchAttributes := []attribute.KeyValue{attribute.String("antnest.event_watch.scope", scope)}
	eventWatchConnections.Add(ctx, 1, metric.WithAttributes(watchAttributes...))
	result := "completed"
	defer func() {
		eventWatchConnections.Add(ctx, -1, metric.WithAttributes(watchAttributes...))
		disconnectAttributes := append(
			watchAttributes, attribute.String("antnest.result", result),
		)
		eventWatchDisconnects.Add(ctx, 1, metric.WithAttributes(disconnectAttributes...))
	}()
	controller := http.NewResponseController(response)
	if err := controller.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		result = "setup_error"
		writeError(response, http.StatusInternalServerError, "internal_error", "streaming is unavailable", true)
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache, no-store")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if err := controller.Flush(); err != nil {
		result = "write_error"
		return
	}
	emit := func(event application.AgentEventView) error {
		payload, err := json.Marshal(agentEventPayload(event))
		if err != nil {
			return fmt.Errorf("encode Agent SSE event: %w", err)
		}
		if _, err := fmt.Fprintf(
			response, "id: %d\nevent: agent_event\ndata: %s\n\n", event.GlobalSequence, payload,
		); err != nil {
			return fmt.Errorf("write Agent SSE event: %w", err)
		}
		return controller.Flush()
	}
	for _, event := range page.Events {
		if err := emit(event); err != nil {
			result = "write_error"
			return
		}
	}
	if err := watch(ctx, page.NextSequence, emit); err != nil {
		if ctx.Err() != nil {
			result = "client_cancel"
			return
		}
		result = "error"
		trace.SpanFromContext(ctx).SetStatus(codes.Error, "event_watch_failed")
		slog.WarnContext(ctx, "Agent event watch ended", "error_class", "event_watch_failed")
	}
}

func (h *handler) rebuildAgent(response http.ResponseWriter, request *http.Request) {
	var payload rebuildAgentRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	ctx := request.Context()
	result, err := h.lifecycle.RebuildAgent(ctx, application.RebuildAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID, AgentID: request.PathValue("agent_id"),
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) disableAgent(response http.ResponseWriter, request *http.Request) {
	var payload lifecycleRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	ctx := request.Context()
	result, err := h.lifecycle.DisableAgent(ctx, application.DisableAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID, AgentID: request.PathValue("agent_id"),
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) enableAgent(response http.ResponseWriter, request *http.Request) {
	var payload lifecycleRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	ctx := request.Context()
	result, err := h.lifecycle.EnableAgent(ctx, application.EnableAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID, AgentID: request.PathValue("agent_id"),
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) deleteAgent(response http.ResponseWriter, request *http.Request) {
	var payload lifecycleRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if strings.TrimSpace(payload.OrganizationID) == "" || strings.TrimSpace(payload.ActorPrincipalID) == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization and actor are required", false)
		return
	}
	ctx := request.Context()
	result, err := h.lifecycle.DeleteAgent(ctx, application.DeleteAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ActorPrincipalID: payload.ActorPrincipalID, AgentID: request.PathValue("agent_id"),
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) getLifecycleOperation(response http.ResponseWriter, request *http.Request) {
	query, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	operation, err := h.lifecycle.GetLifecycleOperation(request.Context(), request.PathValue("request_id"))
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			writeError(response, http.StatusNotFound, "operation_not_found", "lifecycle operation was not found", false)
			return
		}
		writeServiceError(request.Context(), response, err)
		return
	}
	if _, err := h.queries.GetAgentForOrganization(request.Context(), query, operation.AgentID); err != nil {
		if errors.Is(err, application.ErrAgentNotFound) {
			writeError(response, http.StatusNotFound, "operation_not_found", "lifecycle operation was not found", false)
			return
		}
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, operationPayload(operation))
}

func (h *handler) getSkillPreparationStatus(response http.ResponseWriter, request *http.Request) {
	organizationID, ok := requiredOrganizationQuery(response, request)
	if !ok {
		return
	}
	status, err := h.lifecycle.GetSkillPreparationStatus(request.Context(), organizationID, request.PathValue("request_id"))
	if errors.Is(err, ports.ErrNotFound) {
		writeError(response, http.StatusNotFound, "preparation_not_found", "Skill preparation was not found", false)
		return
	}
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, status)
}

func requiredOrganizationQuery(response http.ResponseWriter, request *http.Request) (string, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}})
	if !ok {
		return "", false
	}
	organizationID := strings.TrimSpace(query.Get("organization_id"))
	if organizationID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization is required", false)
		return "", false
	}
	return organizationID, true
}

func catalogListInput(response http.ResponseWriter, request *http.Request) (application.ListCatalogInput, bool) {
	query := request.URL.Query()
	for key := range query {
		if key != "organization_id" && key != "after_id" && key != "limit" {
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return application.ListCatalogInput{}, false
		}
	}
	limit := 0
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return application.ListCatalogInput{}, false
		}
		limit = parsed
	}
	return application.ListCatalogInput{
		OrganizationID: query.Get("organization_id"), AfterID: query.Get("after_id"), Limit: limit,
	}, true
}

func agentListInput(response http.ResponseWriter, request *http.Request) (application.ListAgentsInput, bool) {
	allowed := map[string]struct{}{
		"organization_id": {}, "owner_user_id": {}, "lifecycle_state": {}, "activation_state": {}, "runtime_state": {},
		"include_deleted": {}, "limit": {}, "cursor": {},
	}
	query, ok := strictQuery(response, request, allowed)
	if !ok {
		return application.ListAgentsInput{}, false
	}
	includeDeleted := false
	if values, present := query["include_deleted"]; present {
		switch values[0] {
		case "false":
		case "true":
			includeDeleted = true
		default:
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return application.ListAgentsInput{}, false
		}
	}
	limit := 0
	if values, present := query["limit"]; present {
		raw := values[0]
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return application.ListAgentsInput{}, false
		}
		limit = parsed
	}
	return application.ListAgentsInput{
		OrganizationID: query.Get("organization_id"), OwnerUserID: query.Get("owner_user_id"),
		LifecycleState:  domain.AgentState(query.Get("lifecycle_state")),
		ActivationState: domain.ActivationState(query.Get("activation_state")), RuntimeState: domain.RuntimeState(query.Get("runtime_state")),
		IncludeDeleted: includeDeleted, Limit: limit, Cursor: query.Get("cursor"),
	}, true
}

func eventListInput(response http.ResponseWriter, request *http.Request) (application.ListEventsInput, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{
		"organization_id": {}, "after_sequence": {}, "limit": {},
	})
	if !ok {
		return application.ListEventsInput{}, false
	}
	afterSequence, ok := nonnegativeInt64(response, query.Get("after_sequence"))
	if !ok {
		return application.ListEventsInput{}, false
	}
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return application.ListEventsInput{}, false
		}
		limit = parsed
	}
	organizationID := strings.TrimSpace(query.Get("organization_id"))
	if organizationID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization is required", false)
		return application.ListEventsInput{}, false
	}
	return application.ListEventsInput{
		OrganizationID: organizationID, AfterSequence: afterSequence, Limit: limit,
	}, true
}

func eventWatchInput(
	response http.ResponseWriter, request *http.Request,
) (string, int64, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{
		"organization_id": {}, "after_sequence": {},
	})
	if !ok {
		return "", 0, false
	}
	organizationID := strings.TrimSpace(query.Get("organization_id"))
	if organizationID == "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "organization is required", false)
		return "", 0, false
	}
	querySequence, ok := nonnegativeInt64(response, query.Get("after_sequence"))
	if !ok {
		return "", 0, false
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 || (len(headerValues) == 1 && strings.TrimSpace(headerValues[0]) == "") {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return "", 0, false
	}
	if len(headerValues) == 0 {
		return organizationID, querySequence, true
	}
	headerSequence, ok := nonnegativeInt64(response, strings.TrimSpace(headerValues[0]))
	if !ok {
		return "", 0, false
	}
	return organizationID, headerSequence, true
}

func strictQuery(
	response http.ResponseWriter, request *http.Request, allowed map[string]struct{},
) (url.Values, bool) {
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return nil, false
	}
	for key, values := range query {
		if _, ok := allowed[key]; !ok || len(values) != 1 || values[0] == "" {
			writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
			return nil, false
		}
	}
	return query, true
}

func nonnegativeInt64(response http.ResponseWriter, raw string) (int64, bool) {
	if raw == "" {
		return 0, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return 0, false
	}
	return value, true
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	request.Body = http.MaxBytesReader(response, request.Body, maximumRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		telemetry.RecordBoundaryError(request.Context(), err, "decode_request", "invalid_request", "request JSON could not be decoded", false)
		writeError(response, http.StatusBadRequest, "invalid_request", "request body is invalid", false)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("request contains trailing JSON")
		}
		telemetry.RecordBoundaryError(request.Context(), err, "decode_request", "invalid_request", "request JSON contains trailing or incomplete data", false)
		writeError(response, http.StatusBadRequest, "invalid_request", "request body is invalid", false)
		return false
	}
	observeDTO(response, "request", target)
	return true
}

func modelProfilePayload(view application.ModelProfileView) modelProfileResponse {
	return modelProfileResponse{
		ProviderConnectionID: view.ProviderConnectionID,
		ModelProfileID:       view.ModelProfileID, OrganizationID: view.OrganizationID,
		ProfileKey: view.ProfileKey, DisplayName: view.DisplayName,
		RevisionID: view.RevisionID, Revision: view.Revision, Enabled: view.Enabled,
		Model:     view.Model,
		CreatedAt: view.CreatedAt, UpdatedAt: view.UpdatedAt,
	}
}

func templatePayload(view application.TemplateView) templateResponse {
	return templateResponse{
		TemplateID: view.TemplateID, OrganizationID: view.OrganizationID,
		TemplateKey: view.TemplateKey, Name: view.Name, Revision: view.Revision,
		ModelProfileID: view.ModelProfileID, SystemPrompt: view.SystemPrompt,
		FallbackModelProfileIDs: view.FallbackModelProfileIDs,
		MaxModelRequests:        view.MaxModelRequests, ContextPolicyVersion: view.ContextPolicyVersion,
		Runtime: view.Runtime, SkillRefs: append([]domain.FrozenSkill{}, view.SkillRefs...), SkillSetDigest: view.SkillSetDigest, Enabled: view.Enabled,
		CreatedAt: view.CreatedAt, UpdatedAt: view.UpdatedAt,
	}
}

func createAgentPayload(result application.CreateAgentResult) createAgentResponse {
	return createAgentResponse{
		Agent:     agentPayload(result.Agent),
		Operation: operationPayload(result.Operation),
	}
}

func agentPayload(agent application.AgentView) agentResponse {
	response := agentResponse{
		ActivationState: agent.ActivationState, RuntimeState: agent.RuntimeState,
		RuntimeReason: agent.RuntimeReason, RuntimeDetail: agent.RuntimeDetail, RuntimeObservedAt: agent.RuntimeObservedAt,
		AgentID: agent.AgentID, OrganizationID: agent.OrganizationID,
		OwnerUserID: agent.OwnerUserID, Name: agent.Name,
		DesiredState: agent.DesiredState, LifecycleState: agent.LifecycleState,
		AccessRevision: agent.AccessRevision, AgentSpecRevision: agent.AgentSpecRevisionID,
		ExecutableExecutionRevision:     agent.ExecutionRevisionID,
		LastSuccessfulExecutionRevision: agent.LastSuccessfulExecutionRevisionID,
		ActiveOperationRequestID:        agent.ActiveOperationRequestID,
		FailureStage:                    agent.FailureStage, FailureCode: agent.FailureCode,
		AggregateSequence: agent.AggregateSequence,
		CreatedAt:         agent.CreatedAt, UpdatedAt: agent.UpdatedAt,
	}
	if agent.RuntimeRevision != "" {
		response.Runtime = &runtimeBindingResponse{
			RuntimeRevision: agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID,
			MCPEndpoint: agent.RuntimeMCPEndpoint,
		}
	}
	if agent.Configuration != nil {
		configuration := agent.Configuration
		response.Configuration = &agentConfigurationResponse{
			Template: agentTemplateLineageResponse{
				TemplateID: configuration.TemplateID,
				Revision:   configuration.TemplateRevision, Name: configuration.TemplateName,
			},
			ModelProfile: agentModelProfileLineageResponse{
				ModelProfileID: configuration.ModelProfileID,
				RevisionID:     configuration.ModelProfileRevisionID,
				Revision:       configuration.ModelProfileRevision, Name: configuration.ModelProfileName,
				Model: configuration.Model,
			},
			MaxModelRequests:     configuration.MaxModelRequests,
			ContextPolicyVersion: configuration.ContextPolicyVersion,
			Runtime:              configuration.Runtime,
			SystemSkills:         append([]domain.FrozenSkill{}, configuration.SystemSkills...),
			SkillSetDigest:       configuration.SkillSetDigest,
		}
	}
	return response
}

func operationPayload(operation application.OperationView) operationResponse {
	return operationResponse{
		RequestID: operation.RequestID, AgentID: operation.AgentID,
		Kind: operation.Kind, Phase: operation.Phase, State: operation.State,
		ErrorCode: operation.ErrorCode, ErrorDetail: operation.ErrorDetail,
		CreatedAt: operation.CreatedAt, UpdatedAt: operation.UpdatedAt,
	}
}

func agentEventListPayload(page application.AgentEventPage) agentEventListResponse {
	events := make([]agentEventResponse, 0, len(page.Events))
	for _, event := range page.Events {
		events = append(events, agentEventPayload(event))
	}
	return agentEventListResponse{Events: events, NextSequence: page.NextSequence}
}

func agentEventPayload(event application.AgentEventView) agentEventResponse {
	return agentEventResponse{
		EventID: event.EventID, GlobalSequence: event.GlobalSequence,
		AggregateSequence: event.AggregateSequence, SchemaVersion: event.SchemaVersion,
		AgentID: event.AgentID, EventType: event.EventType,
		OperationRequestID: event.OperationRequestID,
		TraceID:            event.TraceID, OccurredAt: event.OccurredAt, Data: event.Data,
	}
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func writeServiceError(ctx context.Context, response http.ResponseWriter, err error) {
	status, payload := publicError(err)
	telemetry.RecordBoundaryError(ctx, err, "dispatch", payload.Code, payload.Message, status >= 500)
	if status == http.StatusInternalServerError {
		slog.ErrorContext(ctx, "Agent Controller request failed", "error_class", payload.Code)
	}
	writeJSON(response, status, payload)
}

func writeQueryError(ctx context.Context, response http.ResponseWriter, err error) {
	if !errors.Is(err, context.DeadlineExceeded) {
		writeServiceError(ctx, response, err)
		return
	}
	status, payload := publicError(application.ErrDependencyUnavailable)
	telemetry.RecordBoundaryError(ctx, err, "dispatch", payload.Code, payload.Message, true)
	writeJSON(response, status, payload)
}

func publicError(err error) (int, errorResponse) {
	var references *ports.CatalogReferenceConflict
	if errors.As(err, &references) {
		return http.StatusConflict, errorResponse{Code: "resource_in_use", Message: "remove current catalog references before disabling this resource", References: references.References, ReferencesTruncated: references.Truncated}
	}
	switch {
	case errors.Is(err, domain.ErrInvalidImageReference):
		return http.StatusBadRequest, errorResponse{
			Code: "runtime_image_invalid", Message: "Enter a valid image name, tag, or digest reference.",
		}
	case errors.Is(err, application.ErrInvalidInput), errors.Is(err, ports.ErrInvalidModelCandidates):
		return http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "request is invalid"}
	case errors.Is(err, application.ErrInvalidReference), errors.Is(err, ports.ErrNotFound):
		return http.StatusNotFound, errorResponse{Code: "reference_not_found", Message: "referenced resource was not found"}
	case errors.Is(err, application.ErrAccessDenied):
		return http.StatusForbidden, errorResponse{Code: "access_denied", Message: "Agent access is denied"}
	case errors.Is(err, application.ErrAgentNotFound):
		return http.StatusNotFound, errorResponse{Code: "agent_not_found", Message: "Agent was not found"}
	case errors.Is(err, application.ErrAgentNotReady):
		return http.StatusConflict, errorResponse{
			Code: "agent_not_ready", Message: "Agent is not ready", Retryable: true,
		}
	case errors.Is(err, application.ErrLifecycleConflict):
		return http.StatusConflict, errorResponse{Code: "lifecycle_conflict", Message: "Agent lifecycle is busy"}
	case errors.Is(err, ports.ErrDisabledReference):
		return http.StatusConflict, errorResponse{Code: "reference_disabled", Message: "referenced resource is disabled"}
	case errors.Is(err, ports.ErrExecutionCapacityExceeded):
		return http.StatusConflict, errorResponse{Code: "execution_configuration_capacity_exceeded", Message: "execution configuration exceeds the deployment capacity; reduce the proposed configuration"}
	case errors.Is(err, ports.ErrRequestConflict):
		return http.StatusConflict, errorResponse{Code: "request_id_conflict", Message: "request identity is already used"}
	case errors.Is(err, ports.ErrConcurrentChange):
		return http.StatusConflict, errorResponse{Code: "lifecycle_conflict", Message: "resource changed concurrently"}
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, errorResponse{
			Code: "lifecycle_timeout", Message: "lifecycle operation timed out", Retryable: true,
		}
	case errors.Is(err, context.Canceled):
		return http.StatusServiceUnavailable, errorResponse{
			Code: "dependency_unavailable", Message: "dependency is unavailable", Retryable: true,
		}
	case errors.Is(err, application.ErrDependencyUnavailable):
		return http.StatusServiceUnavailable, errorResponse{
			Code: "dependency_unavailable", Message: "dependency is unavailable", Retryable: true,
		}
	default:
		return http.StatusInternalServerError, errorResponse{
			Code: "internal_error", Message: "internal service error", Retryable: true,
		}
	}
}

func observeLifecycleResult(ctx context.Context, operation application.OperationView) {
	if operation.RequestID == "" {
		return
	}
	span := trace.SpanFromContext(ctx)
	metricAttributes := []attribute.KeyValue{
		attribute.String("antnest.lifecycle.kind", string(operation.Kind)),
		attribute.String("antnest.lifecycle.phase", string(operation.Phase)),
		attribute.String("antnest.lifecycle.state", string(operation.State)),
	}
	if operation.State == domain.OperationFailed {
		metricAttributes = append(
			metricAttributes,
			attribute.String("antnest.lifecycle.error_class", lifecycleMetricErrorClass(operation.ErrorCode)),
		)
	}
	span.SetAttributes(append(
		[]attribute.KeyValue{attribute.String("antnest.agent.id", operation.AgentID), attribute.String("antnest.operation.id", operation.RequestID), attribute.String("antnest.operation.phase", string(operation.Phase)), attribute.String("antnest.outcome", string(operation.State))},
		metricAttributes...,
	)...)
	lifecycleOperations.Add(ctx, 1, metric.WithAttributes(metricAttributes...))
	if operation.State != domain.OperationFailed {
		return
	}
	errorClass := lifecycleMetricErrorClass(operation.ErrorCode)
	span.SetStatus(codes.Error, errorClass)
	slog.WarnContext(
		ctx, "Agent lifecycle operation failed",
		"agent_id", operation.AgentID,
		"request_id", operation.RequestID,
		"operation_kind", operation.Kind,
		"failure_stage", operation.Phase,
		"error_class", errorClass,
	)
}

func lifecycleMetricErrorClass(code string) string {
	code = strings.ToLower(strings.TrimSpace(code))
	switch {
	case code == "run_drain_timeout", code == "lifecycle_timeout", strings.Contains(code, "timeout"):
		return "timeout"
	case strings.Contains(code, "policy"):
		return "policy"
	case strings.Contains(code, "network"), strings.Contains(code, "egress"):
		return "network"
	case strings.Contains(code, "runtime"):
		return "runtime"
	case strings.HasPrefix(code, "invalid_"):
		return "invalid_dependency_result"
	case code == "":
		return "unspecified"
	default:
		return "other"
	}
}

func mustLifecycleCounter(counter metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return counter
}

func mustEventWatchConnections(
	counter metric.Int64UpDownCounter, err error,
) metric.Int64UpDownCounter {
	if err != nil {
		panic(err)
	}
	return counter
}

func writeError(response http.ResponseWriter, status int, code string, message string, retryable bool) {
	writeJSON(response, status, errorResponse{Code: code, Message: message, Retryable: retryable})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		http.Error(response, "internal service error", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	observeDTO(response, "response", value)
	if _, err := response.Write(append(payload, '\n')); err != nil {
		slog.Error("write Agent Controller response", "error_class", "response_write")
	}
}
