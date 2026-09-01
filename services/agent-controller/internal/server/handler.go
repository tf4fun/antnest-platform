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

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const maximumRequestBytes = 2 << 20

var (
	serverMeter         = otel.Meter("soft/antnest-platform/agent-controller/server")
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
	CreateModelProfile(context.Context, application.CreateModelProfileInput) (application.ModelProfileView, error)
	ReviseModelProfile(context.Context, application.ReviseModelProfileInput) (application.ModelProfileView, error)
	GetModelProfile(context.Context, string) (application.ModelProfileView, error)
	ListModelProfiles(context.Context, application.ListCatalogInput) (application.ModelProfilePage, error)
	CreateTemplate(context.Context, application.CreateTemplateInput) (application.TemplateView, error)
	ReviseTemplate(context.Context, application.ReviseTemplateInput) (application.TemplateView, error)
	GetTemplate(context.Context, string) (application.TemplateView, error)
	ListTemplates(context.Context, application.ListCatalogInput) (application.TemplatePage, error)
}

type LifecycleService interface {
	CreateAgent(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error)
	RebuildAgent(context.Context, application.RebuildAgentInput) (application.RebuildAgentResult, error)
	DisableAgent(context.Context, application.DisableAgentInput) (application.DisableAgentResult, error)
	EnableAgent(context.Context, application.EnableAgentInput) (application.EnableAgentResult, error)
	DeleteAgent(context.Context, application.DeleteAgentInput) (application.DeleteAgentResult, error)
	GetLifecycleOperation(context.Context, string) (application.OperationView, error)
}

type RunService interface {
	ResolveAgentAccess(context.Context, application.ResolveAgentAccessInput) (application.AgentAccessView, error)
	AcquireRun(context.Context, application.AcquireRunInput) (application.AcquireRunResult, error)
	ResolveCredential(context.Context, application.ResolveCredentialInput) (application.CredentialView, error)
	FinishRun(context.Context, application.FinishRunInput) (application.FinishRunResult, error)
}

type AgentQueryService interface {
	GetAgent(context.Context, string) (application.AgentView, error)
	ListAgents(context.Context, application.ListAgentsInput) (application.AgentPage, error)
}

type AgentEventService interface {
	ListGlobalEvents(context.Context, application.ListEventsInput) (application.AgentEventPage, error)
	ListAgentEvents(context.Context, application.ListAgentEventsInput) (application.AgentEventPage, error)
	WatchGlobalEvents(context.Context, int64, application.AgentEventEmitter) error
	WatchAgentEvents(context.Context, string, int64, application.AgentEventEmitter) error
}

type HealthCheck func(context.Context) error

type handler struct {
	catalog          CatalogService
	lifecycle        LifecycleService
	runs             RunService
	queries          AgentQueryService
	events           AgentEventService
	health           HealthCheck
	lifecycleTimeout time.Duration
}

type routeDefinition struct {
	pattern string
	handler http.HandlerFunc
}

type HandlerOption func(*handler) error

func WithLifecycleTimeout(timeout time.Duration) HandlerOption {
	return func(h *handler) error {
		if timeout <= 0 {
			return fmt.Errorf("lifecycle timeout must be positive")
		}
		h.lifecycleTimeout = timeout
		return nil
	}
}

func NewHandler(
	catalog CatalogService,
	lifecycle LifecycleService,
	runs RunService,
	queries AgentQueryService,
	events AgentEventService,
	health HealthCheck,
	options ...HandlerOption,
) (http.Handler, error) {
	if catalog == nil {
		return nil, fmt.Errorf("catalog service is required")
	}
	if lifecycle == nil {
		return nil, fmt.Errorf("lifecycle service is required")
	}
	if runs == nil {
		return nil, fmt.Errorf("run service is required")
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
	h := &handler{
		catalog: catalog, lifecycle: lifecycle, runs: runs, queries: queries, events: events, health: health,
	}
	for _, option := range options {
		if option == nil {
			return nil, fmt.Errorf("handler option is required")
		}
		if err := option(h); err != nil {
			return nil, err
		}
	}
	mux := http.NewServeMux()
	for _, route := range h.routes() {
		mux.HandleFunc(route.pattern, route.handler)
	}
	return mux, nil
}

func (h *handler) routes() []routeDefinition {
	return []routeDefinition{
		{pattern: "GET /status", handler: h.status},
		{pattern: "GET /rpc/agent-controller/status", handler: h.status},
		{pattern: "POST /rpc/agent-controller/resolve-agent-access", handler: h.resolveAgentAccess},
		{pattern: "POST /rpc/agent-controller/acquire-run", handler: h.acquireRun},
		{pattern: "POST /rpc/agent-controller/resolve-credential", handler: h.resolveCredential},
		{pattern: "POST /rpc/agent-controller/finish-run", handler: h.finishRun},
		{pattern: "POST /internal/model-profiles", handler: h.createModelProfile},
		{pattern: "GET /internal/model-profiles", handler: h.listModelProfiles},
		{pattern: "GET /internal/model-profiles/{model_profile_id}", handler: h.getModelProfile},
		{pattern: "POST /internal/model-profiles/{model_profile_id}/revisions", handler: h.reviseModelProfile},
		{pattern: "POST /internal/agent-templates", handler: h.createTemplate},
		{pattern: "GET /internal/agent-templates", handler: h.listTemplates},
		{pattern: "GET /internal/agent-templates/{template_id}", handler: h.getTemplate},
		{pattern: "POST /internal/agent-templates/{template_id}/revisions", handler: h.reviseTemplate},
		{pattern: "POST /internal/agents", handler: h.createAgent},
		{pattern: "GET /internal/agents", handler: h.listAgents},
		{pattern: "GET /internal/agents/{agent_id}", handler: h.getAgent},
		{pattern: "POST /internal/agents/{agent_id}/rebuild", handler: h.rebuildAgent},
		{pattern: "POST /internal/agents/{agent_id}/disable", handler: h.disableAgent},
		{pattern: "POST /internal/agents/{agent_id}/enable", handler: h.enableAgent},
		{pattern: "POST /internal/agents/{agent_id}/delete", handler: h.deleteAgent},
		{pattern: "GET /internal/agent-operations/{request_id}", handler: h.getLifecycleOperation},
		{pattern: "GET /internal/agent-events", handler: h.listGlobalAgentEvents},
		{pattern: "GET /internal/agent-events/watch", handler: h.watchGlobalAgentEvents},
		{pattern: "GET /internal/agents/{agent_id}/events", handler: h.listAgentEvents},
		{pattern: "GET /internal/agents/{agent_id}/events/watch", handler: h.watchAgentEvents},
	}
}

type credentialInput struct {
	SecretType string `json:"secret_type"`
	Secret     string `json:"secret"`
}

type createModelProfileRequest struct {
	RequestID      string           `json:"request_id"`
	OrganizationID string           `json:"organization_id"`
	ProfileKey     string           `json:"profile_key"`
	DisplayName    string           `json:"display_name"`
	Model          domain.ModelSpec `json:"model"`
	Credential     credentialInput  `json:"credential"`
}

type reviseModelProfileRequest struct {
	RequestID   string           `json:"request_id"`
	DisplayName string           `json:"display_name"`
	Model       domain.ModelSpec `json:"model"`
	Credential  credentialInput  `json:"credential"`
}

type createTemplateRequest struct {
	RequestID              string                  `json:"request_id"`
	OrganizationID         string                  `json:"organization_id"`
	TemplateKey            string                  `json:"template_key"`
	Name                   string                  `json:"name"`
	ModelProfileRevisionID string                  `json:"model_profile_revision_id"`
	SystemPrompt           string                  `json:"system_prompt"`
	MaxModelRequests       int                     `json:"max_model_requests"`
	ContextPolicyVersion   string                  `json:"context_policy_version"`
	Runtime                domain.RuntimeSpecInput `json:"runtime"`
}

type reviseTemplateRequest struct {
	RequestID              string                  `json:"request_id"`
	Name                   string                  `json:"name"`
	ModelProfileRevisionID string                  `json:"model_profile_revision_id"`
	SystemPrompt           string                  `json:"system_prompt"`
	MaxModelRequests       int                     `json:"max_model_requests"`
	ContextPolicyVersion   string                  `json:"context_policy_version"`
	Runtime                domain.RuntimeSpecInput `json:"runtime"`
}

type createAgentRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationID   string `json:"organization_id"`
	OwnerUserID      string `json:"owner_user_id"`
	Name             string `json:"name"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

type rebuildAgentRequest struct {
	RequestID        string `json:"request_id"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

type lifecycleRequest struct {
	RequestID string `json:"request_id"`
}

type resolveAgentAccessRequest struct {
	RequestID          string `json:"request_id"`
	AgentAccessSubject string `json:"agent_access_subject"`
}

type acquireRunRequest struct {
	RequestID              string `json:"request_id"`
	AgentID                string `json:"agent_id"`
	PrincipalID            string `json:"principal_id"`
	ExpectedAccessRevision string `json:"expected_access_revision"`
	SessionID              string `json:"session_id"`
}

type resolveCredentialRequest struct {
	RequestID     string `json:"request_id"`
	AdmissionID   string `json:"admission_id"`
	CredentialRef string `json:"credential_ref"`
}

type nullableString struct {
	Present bool
	Null    bool
	Value   string
}

func (value *nullableString) UnmarshalJSON(payload []byte) error {
	value.Present = true
	if string(payload) == "null" {
		value.Null = true
		value.Value = ""
		return nil
	}
	value.Null = false
	return json.Unmarshal(payload, &value.Value)
}

type finishRunRequest struct {
	RequestID           string                 `json:"request_id"`
	AdmissionID         string                 `json:"admission_id"`
	TerminalClass       domain.TerminalClass   `json:"terminal_class"`
	ToolEffectState     domain.ToolEffectState `json:"tool_effect_state"`
	UnknownEffectSource nullableString         `json:"unknown_effect_source"`
	StopReason          nullableString         `json:"stop_reason"`
	ErrorClass          nullableString         `json:"error_class"`
}

type modelProfileResponse struct {
	ModelProfileID    string           `json:"model_profile_id"`
	OrganizationID    string           `json:"organization_id"`
	ProfileKey        string           `json:"profile_key"`
	DisplayName       string           `json:"display_name"`
	RevisionID        string           `json:"revision_id"`
	Revision          int64            `json:"revision"`
	Enabled           bool             `json:"enabled"`
	Model             domain.ModelSpec `json:"model"`
	CredentialRef     string           `json:"credential_ref"`
	CredentialVersion string           `json:"credential_version"`
	CreatedAt         time.Time        `json:"created_at"`
	UpdatedAt         time.Time        `json:"updated_at"`
}

type templateResponse struct {
	TemplateID             string                  `json:"template_id"`
	OrganizationID         string                  `json:"organization_id"`
	TemplateKey            string                  `json:"template_key"`
	Name                   string                  `json:"name"`
	Revision               int64                   `json:"revision"`
	ModelProfileRevisionID string                  `json:"model_profile_revision_id"`
	SystemPrompt           string                  `json:"system_prompt"`
	MaxModelRequests       int                     `json:"max_model_requests"`
	ContextPolicyVersion   string                  `json:"context_policy_version"`
	Runtime                domain.RuntimeSpecInput `json:"runtime"`
	SkillRefs              []string                `json:"skill_refs"`
	Enabled                bool                    `json:"enabled"`
	CreatedAt              time.Time               `json:"created_at"`
	UpdatedAt              time.Time               `json:"updated_at"`
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
	RuntimeExecutionID string `json:"runtime_execution_id"`
	MCPEndpoint        string `json:"mcp_endpoint"`
}

type agentResponse struct {
	AgentID                         string                  `json:"agent_id"`
	OrganizationID                  string                  `json:"organization_id"`
	OwnerUserID                     string                  `json:"owner_user_id"`
	Name                            string                  `json:"name"`
	DesiredState                    domain.DesiredState     `json:"desired_state"`
	LifecycleState                  domain.AgentState       `json:"lifecycle_state"`
	AccessRevision                  string                  `json:"access_revision"`
	AgentSpecRevision               string                  `json:"agent_spec_revision,omitempty"`
	ExecutableExecutionRevision     string                  `json:"executable_execution_revision,omitempty"`
	LastSuccessfulExecutionRevision string                  `json:"last_successful_execution_revision,omitempty"`
	Runtime                         *runtimeBindingResponse `json:"runtime,omitempty"`
	ActiveOperationRequestID        string                  `json:"active_operation_request_id,omitempty"`
	FailureStage                    string                  `json:"failure_stage,omitempty"`
	FailureCode                     string                  `json:"failure_code,omitempty"`
	AggregateSequence               int64                   `json:"aggregate_sequence"`
	CreatedAt                       time.Time               `json:"created_at"`
	UpdatedAt                       time.Time               `json:"updated_at"`
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
	AdmissionID        string         `json:"admission_id,omitempty"`
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
	Agent              agentResponse     `json:"agent"`
	AgentAccessSubject string            `json:"agent_access_subject"`
	Operation          operationResponse `json:"operation"`
}

type resolveAgentAccessResponse struct {
	PrincipalID        string                   `json:"principal_id"`
	AgentID            string                   `json:"agent_id"`
	AccessRevision     string                   `json:"access_revision"`
	PromptCapabilities ports.PromptCapabilities `json:"prompt_capabilities"`
}

type acquireRunResponse struct {
	AdmissionID              string                      `json:"admission_id"`
	AdmissionDeadline        time.Time                   `json:"admission_deadline"`
	AgentSpecRevision        string                      `json:"agent_spec_revision"`
	ExecutionRevision        string                      `json:"execution_revision"`
	RuntimeMCPSourceDigest   string                      `json:"runtime_mcp_source_digest"`
	AgentExecutionSpecDigest string                      `json:"agent_execution_spec_digest"`
	CredentialVersion        string                      `json:"credential_version"`
	Runtime                  ports.AdmittedRuntime       `json:"runtime"`
	ExecutionSpec            ports.AdmittedExecutionSpec `json:"execution_spec"`
}

type resolveCredentialResponse struct {
	CredentialVersion string `json:"credential_version"`
	SecretType        string `json:"secret_type"`
	Secret            string `json:"secret"`
}

type finishRunResponse struct {
	Status         string                `json:"status"`
	AdmissionState domain.AdmissionState `json:"admission_state"`
}

type errorResponse struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	if err := h.health(request.Context()); err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) resolveAgentAccess(response http.ResponseWriter, request *http.Request) {
	var payload resolveAgentAccessRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.runs.ResolveAgentAccess(request.Context(), application.ResolveAgentAccessInput{
		RequestID: payload.RequestID, AgentAccessSubject: payload.AgentAccessSubject,
	})
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, resolveAgentAccessResponse{
		PrincipalID: result.PrincipalID, AgentID: result.AgentID,
		AccessRevision: result.AccessRevision, PromptCapabilities: result.PromptCapabilities,
	})
}

func (h *handler) acquireRun(response http.ResponseWriter, request *http.Request) {
	var payload acquireRunRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.runs.AcquireRun(request.Context(), application.AcquireRunInput{
		RequestID: payload.RequestID, AgentID: payload.AgentID,
		PrincipalID: payload.PrincipalID, ExpectedAccessRevision: payload.ExpectedAccessRevision,
		SessionID: payload.SessionID,
	})
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, acquireRunResponse{
		AdmissionID: result.AdmissionID, AdmissionDeadline: result.AdmissionDeadline,
		AgentSpecRevision: result.AgentSpecRevision, ExecutionRevision: result.ExecutionRevision,
		RuntimeMCPSourceDigest:   result.RuntimeMCPSourceDigest,
		AgentExecutionSpecDigest: result.AgentExecutionSpecDigest,
		CredentialVersion:        result.CredentialVersion, Runtime: result.Runtime,
		ExecutionSpec: result.ExecutionSpec,
	})
}

func (h *handler) resolveCredential(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	var payload resolveCredentialRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.runs.ResolveCredential(request.Context(), application.ResolveCredentialInput{
		RequestID: payload.RequestID, AdmissionID: payload.AdmissionID,
		CredentialRef: payload.CredentialRef,
	})
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, resolveCredentialResponse{
		CredentialVersion: result.CredentialVersion,
		SecretType:        result.SecretType, Secret: result.Secret,
	})
}

func (h *handler) finishRun(response http.ResponseWriter, request *http.Request) {
	var payload finishRunRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if !payload.UnknownEffectSource.Present || !payload.StopReason.Present || !payload.ErrorClass.Present {
		writeRunError(request.Context(), response, application.ErrInvalidInput)
		return
	}
	if (payload.TerminalClass == domain.TerminalUnresolved && payload.UnknownEffectSource.Null) ||
		(payload.TerminalClass != domain.TerminalUnresolved && !payload.UnknownEffectSource.Null) {
		writeRunError(request.Context(), response, application.ErrInvalidInput)
		return
	}
	result, err := h.runs.FinishRun(request.Context(), application.FinishRunInput{
		RequestID: payload.RequestID, AdmissionID: payload.AdmissionID,
		TerminalClass: payload.TerminalClass, ToolEffectState: payload.ToolEffectState,
		UnknownEffectSource: domain.UnknownEffectSource(payload.UnknownEffectSource.Value),
		StopReason:          payload.StopReason.Value, ErrorClass: payload.ErrorClass.Value,
	})
	if err != nil {
		writeRunError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, finishRunResponse{
		Status: result.Status, AdmissionState: result.AdmissionState,
	})
}

func (h *handler) createModelProfile(response http.ResponseWriter, request *http.Request) {
	var payload createModelProfileRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	if payload.Credential.SecretType != "bearer" {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return
	}
	view, err := h.catalog.CreateModelProfile(request.Context(), application.CreateModelProfileInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		ProfileKey: payload.ProfileKey, DisplayName: payload.DisplayName,
		Model: payload.Model, CredentialSecret: payload.Credential.Secret,
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
	if payload.Credential.SecretType != "bearer" {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return
	}
	view, err := h.catalog.ReviseModelProfile(request.Context(), application.ReviseModelProfileInput{
		RequestID: payload.RequestID, ModelProfileID: request.PathValue("model_profile_id"),
		DisplayName: payload.DisplayName, Model: payload.Model,
		CredentialSecret: payload.Credential.Secret,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, modelProfilePayload(view))
}

func (h *handler) getModelProfile(response http.ResponseWriter, request *http.Request) {
	view, err := h.catalog.GetModelProfile(request.Context(), request.PathValue("model_profile_id"))
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
		ModelProfileRevisionID: payload.ModelProfileRevisionID,
		SystemPrompt:           payload.SystemPrompt, MaxModelRequests: payload.MaxModelRequests,
		ContextPolicyVersion: payload.ContextPolicyVersion, Runtime: payload.Runtime,
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
		ModelProfileRevisionID: payload.ModelProfileRevisionID,
		SystemPrompt:           payload.SystemPrompt, MaxModelRequests: payload.MaxModelRequests,
		ContextPolicyVersion: payload.ContextPolicyVersion, Runtime: payload.Runtime,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusCreated, templatePayload(view))
}

func (h *handler) getTemplate(response http.ResponseWriter, request *http.Request) {
	view, err := h.catalog.GetTemplate(request.Context(), request.PathValue("template_id"))
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
	ctx, cancel := h.lifecycleContext(request.Context())
	defer cancel()
	result, err := h.lifecycle.CreateAgent(ctx, application.CreateAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		OwnerUserID: payload.OwnerUserID, Name: payload.Name,
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
		InitialTraceParent: traceParentFromContext(ctx),
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, createAgentPayload(result))
}

func (h *handler) lifecycleContext(parent context.Context) (context.Context, context.CancelFunc) {
	if h.lifecycleTimeout <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, h.lifecycleTimeout)
}

func traceParentFromContext(ctx context.Context) string {
	spanContext := trace.SpanContextFromContext(ctx)
	if !spanContext.IsValid() {
		return ""
	}
	return fmt.Sprintf(
		"00-%s-%s-%02x",
		spanContext.TraceID(), spanContext.SpanID(), byte(spanContext.TraceFlags()),
	)
}

func (h *handler) getAgent(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if request.URL.RawQuery != "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return
	}
	agent, err := h.queries.GetAgent(request.Context(), request.PathValue("agent_id"))
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
		AgentID:       request.PathValue("agent_id"),
		AfterSequence: input.AfterSequence, Limit: input.Limit,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, agentEventListPayload(page))
}

func (h *handler) watchGlobalAgentEvents(response http.ResponseWriter, request *http.Request) {
	afterSequence, ok := eventWatchCursor(response, request)
	if !ok {
		return
	}
	page, err := h.events.ListGlobalEvents(request.Context(), application.ListEventsInput{
		AfterSequence: afterSequence,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	h.streamAgentEvents(response, request, "global", page, func(
		ctx context.Context, cursor int64, emit application.AgentEventEmitter,
	) error {
		return h.events.WatchGlobalEvents(ctx, cursor, emit)
	})
}

func (h *handler) watchAgentEvents(response http.ResponseWriter, request *http.Request) {
	afterSequence, ok := eventWatchCursor(response, request)
	if !ok {
		return
	}
	agentID := request.PathValue("agent_id")
	page, err := h.events.ListAgentEvents(request.Context(), application.ListAgentEventsInput{
		AgentID: agentID, AfterSequence: afterSequence,
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	h.streamAgentEvents(response, request, "agent", page, func(
		ctx context.Context, cursor int64, emit application.AgentEventEmitter,
	) error {
		return h.events.WatchAgentEvents(ctx, agentID, cursor, emit)
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
	ctx, cancel := h.lifecycleContext(request.Context())
	defer cancel()
	result, err := h.lifecycle.RebuildAgent(ctx, application.RebuildAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
		InitialTraceParent: traceParentFromContext(ctx),
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
	ctx, cancel := h.lifecycleContext(request.Context())
	defer cancel()
	result, err := h.lifecycle.DisableAgent(ctx, application.DisableAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		InitialTraceParent: traceParentFromContext(ctx),
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
	ctx, cancel := h.lifecycleContext(request.Context())
	defer cancel()
	result, err := h.lifecycle.EnableAgent(ctx, application.EnableAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		InitialTraceParent: traceParentFromContext(ctx),
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
	ctx, cancel := h.lifecycleContext(request.Context())
	defer cancel()
	result, err := h.lifecycle.DeleteAgent(ctx, application.DeleteAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		InitialTraceParent: traceParentFromContext(ctx),
	})
	observeLifecycleResult(ctx, result.Operation)
	if err != nil {
		writeServiceError(ctx, response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) getLifecycleOperation(response http.ResponseWriter, request *http.Request) {
	operation, err := h.lifecycle.GetLifecycleOperation(request.Context(), request.PathValue("request_id"))
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			writeError(response, http.StatusNotFound, "operation_not_found", "lifecycle operation was not found", false)
			return
		}
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, operationPayload(operation))
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
		"organization_id": {}, "owner_user_id": {}, "lifecycle_state": {},
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
		LifecycleState: domain.AgentState(query.Get("lifecycle_state")),
		IncludeDeleted: includeDeleted, Limit: limit, Cursor: query.Get("cursor"),
	}, true
}

func eventListInput(response http.ResponseWriter, request *http.Request) (application.ListEventsInput, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{
		"after_sequence": {}, "limit": {},
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
	return application.ListEventsInput{AfterSequence: afterSequence, Limit: limit}, true
}

func eventWatchCursor(response http.ResponseWriter, request *http.Request) (int64, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{"after_sequence": {}})
	if !ok {
		return 0, false
	}
	querySequence, ok := nonnegativeInt64(response, query.Get("after_sequence"))
	if !ok {
		return 0, false
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 || (len(headerValues) == 1 && strings.TrimSpace(headerValues[0]) == "") {
		writeError(response, http.StatusBadRequest, "invalid_request", "request is invalid", false)
		return 0, false
	}
	if len(headerValues) == 0 {
		return querySequence, true
	}
	headerSequence, ok := nonnegativeInt64(response, strings.TrimSpace(headerValues[0]))
	if !ok {
		return 0, false
	}
	return headerSequence, true
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
		writeError(response, http.StatusBadRequest, "invalid_request", "request body is invalid", false)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_request", "request body is invalid", false)
		return false
	}
	return true
}

func modelProfilePayload(view application.ModelProfileView) modelProfileResponse {
	return modelProfileResponse{
		ModelProfileID: view.ModelProfileID, OrganizationID: view.OrganizationID,
		ProfileKey: view.ProfileKey, DisplayName: view.DisplayName,
		RevisionID: view.RevisionID, Revision: view.Revision, Enabled: view.Enabled,
		Model: view.Model, CredentialRef: view.CredentialRef,
		CredentialVersion: view.CredentialVersion,
		CreatedAt:         view.CreatedAt, UpdatedAt: view.UpdatedAt,
	}
}

func templatePayload(view application.TemplateView) templateResponse {
	return templateResponse{
		TemplateID: view.TemplateID, OrganizationID: view.OrganizationID,
		TemplateKey: view.TemplateKey, Name: view.Name, Revision: view.Revision,
		ModelProfileRevisionID: view.ModelProfileRevisionID, SystemPrompt: view.SystemPrompt,
		MaxModelRequests: view.MaxModelRequests, ContextPolicyVersion: view.ContextPolicyVersion,
		Runtime: view.Runtime, SkillRefs: []string{}, Enabled: view.Enabled,
		CreatedAt: view.CreatedAt, UpdatedAt: view.UpdatedAt,
	}
}

func createAgentPayload(result application.CreateAgentResult) createAgentResponse {
	return createAgentResponse{
		Agent: agentPayload(result.Agent), AgentAccessSubject: result.AgentAccessSubject,
		Operation: operationPayload(result.Operation),
	}
}

func agentPayload(agent application.AgentView) agentResponse {
	response := agentResponse{
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
	if agent.RuntimeRevision != "" && agent.RuntimeExecutionID != "" && agent.RuntimeMCPEndpoint != "" {
		response.Runtime = &runtimeBindingResponse{
			RuntimeRevision: agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID,
			MCPEndpoint: agent.RuntimeMCPEndpoint,
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
		OperationRequestID: event.OperationRequestID, AdmissionID: event.AdmissionID,
		TraceID: event.TraceID, OccurredAt: event.OccurredAt, Data: event.Data,
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
	if status == http.StatusInternalServerError {
		slog.ErrorContext(ctx, "Agent Controller request failed", "error_class", payload.Code)
	}
	writeJSON(response, status, payload)
}

func writeRunError(ctx context.Context, response http.ResponseWriter, err error) {
	status, payload := publicRunError(err)
	if status == http.StatusInternalServerError {
		slog.ErrorContext(ctx, "Agent Controller Run request failed", "error_class", payload.Code)
	}
	writeJSON(response, status, payload)
}

func publicRunError(err error) (int, errorResponse) {
	switch {
	case errors.Is(err, application.ErrInvalidInput):
		return http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "request is invalid"}
	case errors.Is(err, application.ErrAccessDenied):
		return http.StatusForbidden, errorResponse{Code: "access_denied", Message: "Agent access is denied"}
	case errors.Is(err, application.ErrAgentNotFound):
		return http.StatusNotFound, errorResponse{Code: "agent_not_found", Message: "Agent was not found"}
	case errors.Is(err, application.ErrAgentBusy):
		return http.StatusConflict, errorResponse{Code: "agent_busy", Message: "Agent is busy", Retryable: true}
	case errors.Is(err, application.ErrAgentRebuilding):
		return http.StatusConflict, errorResponse{
			Code: "agent_rebuilding", Message: "Agent lifecycle is changing", Retryable: true,
		}
	case errors.Is(err, application.ErrAgentBuildFailed):
		return http.StatusConflict, errorResponse{
			Code: "agent_build_failed", Message: "Agent build requires administrator action",
		}
	case errors.Is(err, application.ErrAgentNotReady):
		return http.StatusConflict, errorResponse{
			Code: "agent_not_ready", Message: "Agent is not executable", Retryable: true,
		}
	case errors.Is(err, application.ErrAdmissionNotFound):
		return http.StatusNotFound, errorResponse{
			Code: "admission_not_found", Message: "Run admission was not found",
		}
	case errors.Is(err, application.ErrCredentialNotAllowed):
		return http.StatusForbidden, errorResponse{
			Code: "credential_not_allowed", Message: "credential is not allowed for this Run",
		}
	case errors.Is(err, application.ErrLifecycleConflict), errors.Is(err, ports.ErrRequestConflict):
		return http.StatusBadRequest, errorResponse{
			Code: "invalid_request", Message: "Run terminal facts conflict with the stored report",
		}
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled),
		errors.Is(err, application.ErrDependencyUnavailable):
		return http.StatusServiceUnavailable, errorResponse{
			Code: "dependency_unavailable", Message: "dependency is unavailable", Retryable: true,
		}
	default:
		return http.StatusInternalServerError, errorResponse{
			Code: "internal_error", Message: "internal service error", Retryable: true,
		}
	}
}

func publicError(err error) (int, errorResponse) {
	switch {
	case errors.Is(err, application.ErrInvalidInput):
		return http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "request is invalid"}
	case errors.Is(err, application.ErrInvalidReference), errors.Is(err, ports.ErrNotFound):
		return http.StatusNotFound, errorResponse{Code: "reference_not_found", Message: "referenced resource was not found"}
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
		[]attribute.KeyValue{attribute.String("antnest.agent.id", operation.AgentID)},
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
	if _, err := response.Write(append(payload, '\n')); err != nil {
		slog.Error("write Agent Controller response", "error_class", "response_write")
	}
}
