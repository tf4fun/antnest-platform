package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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

var lifecycleOperations = mustLifecycleCounter(
	otel.Meter("soft/antnest-platform/agent-controller/server").Int64Counter(
		"antnest.agent_controller.lifecycle.operations",
		metric.WithDescription("Agent lifecycle request outcomes"),
	),
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
	GetLifecycleOperation(context.Context, string) (application.OperationView, error)
}

type HealthCheck func(context.Context) error

type handler struct {
	catalog   CatalogService
	lifecycle LifecycleService
	health    HealthCheck
}

func NewHandler(
	catalog CatalogService, lifecycle LifecycleService, health HealthCheck,
) (http.Handler, error) {
	if catalog == nil {
		return nil, fmt.Errorf("catalog service is required")
	}
	if lifecycle == nil {
		return nil, fmt.Errorf("lifecycle service is required")
	}
	if health == nil {
		return nil, fmt.Errorf("health check is required")
	}
	h := &handler{catalog: catalog, lifecycle: lifecycle, health: health}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", h.status)
	mux.HandleFunc("POST /internal/model-profiles", h.createModelProfile)
	mux.HandleFunc("GET /internal/model-profiles", h.listModelProfiles)
	mux.HandleFunc("GET /internal/model-profiles/{model_profile_id}", h.getModelProfile)
	mux.HandleFunc("POST /internal/model-profiles/{model_profile_id}/revisions", h.reviseModelProfile)
	mux.HandleFunc("POST /internal/agent-templates", h.createTemplate)
	mux.HandleFunc("GET /internal/agent-templates", h.listTemplates)
	mux.HandleFunc("GET /internal/agent-templates/{template_id}", h.getTemplate)
	mux.HandleFunc("POST /internal/agent-templates/{template_id}/revisions", h.reviseTemplate)
	mux.HandleFunc("POST /internal/agents", h.createAgent)
	mux.HandleFunc("POST /internal/agents/{agent_id}/rebuild", h.rebuildAgent)
	mux.HandleFunc("POST /internal/agents/{agent_id}/disable", h.disableAgent)
	mux.HandleFunc("POST /internal/agents/{agent_id}/enable", h.enableAgent)
	mux.HandleFunc("GET /internal/agent-operations/{request_id}", h.getLifecycleOperation)
	return mux, nil
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
	CreatedAt                       time.Time               `json:"created_at"`
	UpdatedAt                       time.Time               `json:"updated_at"`
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
	result, err := h.lifecycle.CreateAgent(request.Context(), application.CreateAgentInput{
		RequestID: payload.RequestID, OrganizationID: payload.OrganizationID,
		OwnerUserID: payload.OwnerUserID, Name: payload.Name,
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
		InitialTraceParent: request.Header.Get("traceparent"),
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, createAgentPayload(result))
}

func (h *handler) rebuildAgent(response http.ResponseWriter, request *http.Request) {
	var payload rebuildAgentRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.lifecycle.RebuildAgent(request.Context(), application.RebuildAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		TemplateID: payload.TemplateID, TemplateRevision: payload.TemplateRevision,
		InitialTraceParent: request.Header.Get("traceparent"),
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	observeLifecycleResult(request.Context(), result.Operation)
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) disableAgent(response http.ResponseWriter, request *http.Request) {
	var payload lifecycleRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.lifecycle.DisableAgent(request.Context(), application.DisableAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		InitialTraceParent: request.Header.Get("traceparent"),
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	observeLifecycleResult(request.Context(), result.Operation)
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) enableAgent(response http.ResponseWriter, request *http.Request) {
	var payload lifecycleRequest
	if !decodeJSON(response, request, &payload) {
		return
	}
	result, err := h.lifecycle.EnableAgent(request.Context(), application.EnableAgentInput{
		RequestID: payload.RequestID, AgentID: request.PathValue("agent_id"),
		InitialTraceParent: request.Header.Get("traceparent"),
	})
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	observeLifecycleResult(request.Context(), result.Operation)
	writeJSON(response, http.StatusAccepted, operationPayload(result.Operation))
}

func (h *handler) getLifecycleOperation(response http.ResponseWriter, request *http.Request) {
	operation, err := h.lifecycle.GetLifecycleOperation(request.Context(), request.PathValue("request_id"))
	if err != nil {
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
		CreatedAt: agent.CreatedAt, UpdatedAt: agent.UpdatedAt,
	}
	if agent.RuntimeRevision != "" || agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" {
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

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func writeServiceError(ctx context.Context, response http.ResponseWriter, err error) {
	status, payload := publicError(err)
	if status == http.StatusInternalServerError {
		slog.ErrorContext(ctx, "Agent Controller request failed", "error_class", payload.Code, "error", err)
	}
	writeJSON(response, status, payload)
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
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
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
	span := trace.SpanFromContext(ctx)
	metricAttributes := []attribute.KeyValue{
		attribute.String("antnest.lifecycle.kind", string(operation.Kind)),
		attribute.String("antnest.lifecycle.phase", string(operation.Phase)),
		attribute.String("antnest.lifecycle.state", string(operation.State)),
	}
	if operation.State == domain.OperationFailed {
		metricAttributes = append(
			metricAttributes, attribute.String("antnest.lifecycle.error_class", operation.ErrorCode),
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
	span.SetStatus(codes.Error, operation.ErrorCode)
	slog.WarnContext(
		ctx, "Agent lifecycle operation failed",
		"agent_id", operation.AgentID,
		"request_id", operation.RequestID,
		"operation_kind", operation.Kind,
		"failure_stage", operation.Phase,
		"failure_code", operation.ErrorCode,
	)
}

func mustLifecycleCounter(counter metric.Int64Counter, err error) metric.Int64Counter {
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
