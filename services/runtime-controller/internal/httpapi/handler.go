package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

const maxRequestBody = 12 << 20

type Service interface {
	Prepare(context.Context, application.PrepareInput) (domain.PreparePlan, error)
	Stop(context.Context, application.LifecycleInput) (domain.LifecyclePlan, error)
	Retire(context.Context, application.LifecycleInput) (domain.LifecyclePlan, error)
	Purge(context.Context, application.LifecycleInput) (domain.LifecyclePlan, error)
	UpdateNetworkPolicy(context.Context, application.NetworkPolicyInput) (domain.NetworkPolicyPlan, error)
	GetRuntime(context.Context, string) (domain.Runtime, error)
	GetOperation(context.Context, string) (domain.Operation, error)
}

type Handler struct {
	service   Service
	work      WorkService
	mux       *http.ServeMux
	readiness func(context.Context) error
}

func New(service Service, work WorkService) (*Handler, error) {
	return NewWithReadiness(service, work, func(context.Context) error { return nil })
}

func NewWithReadiness(
	service Service, work WorkService, readiness func(context.Context) error,
) (*Handler, error) {
	if service == nil || work == nil {
		return nil, fmt.Errorf("runtime lifecycle and work services are required")
	}
	if readiness == nil {
		return nil, fmt.Errorf("readiness check is required")
	}
	handler := &Handler{service: service, work: work, mux: http.NewServeMux(), readiness: readiness}
	handler.registerRoutes()
	return handler, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

func (h *Handler) registerRoutes() {
	h.mux.HandleFunc("GET /healthz", health)
	h.mux.HandleFunc("GET /readyz", h.ready)
	h.mux.HandleFunc("PUT /internal/v1/runtimes/{agent_id}", h.prepare)
	h.mux.HandleFunc("GET /internal/v1/runtimes/{agent_id}", h.getRuntime)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/stop", h.stop)
	h.mux.HandleFunc("DELETE /internal/v1/runtimes/{agent_id}", h.retire)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/purge", h.purge)
	h.mux.HandleFunc("PUT /internal/v1/runtimes/{agent_id}/network-policy", h.updateNetworkPolicy)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/work:begin", h.beginWork)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/work:end", h.endWork)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/process:exec", h.exec)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/files:read", h.readFile)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/files:write", h.writeFile)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/files:edit", h.editFile)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/files:list", h.listDir)
	h.mux.HandleFunc("POST /internal/v1/runtimes/{agent_id}/operations:cancel", h.cancelOperation)
	h.mux.HandleFunc("GET /internal/v1/runtime-operations/{operation_id}", h.getOperation)
}

func health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) ready(response http.ResponseWriter, request *http.Request) {
	if err := h.readiness(request.Context()); err != nil {
		writeProblem(response, request, http.StatusServiceUnavailable, "not_ready", "service dependencies are unavailable")
		return
	}
	health(response, request)
}

func (h *Handler) prepare(response http.ResponseWriter, request *http.Request) {
	idempotencyKey, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var body struct {
		ImageRef    string             `json:"image_ref"`
		NetworkMode domain.NetworkMode `json:"network_mode"`
	}
	if !decodeJSON(response, request, &body) {
		return
	}
	result, err := h.service.Prepare(request.Context(), application.PrepareInput{
		AgentID: request.PathValue("agent_id"), ImageRef: body.ImageRef,
		NetworkMode: body.NetworkMode, IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationFrom(result.Operation))
}

func (h *Handler) getRuntime(response http.ResponseWriter, request *http.Request) {
	runtime, err := h.service.GetRuntime(request.Context(), request.PathValue("agent_id"))
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, runtimeFrom(runtime))
}

func (h *Handler) stop(response http.ResponseWriter, request *http.Request) {
	h.lifecycle(response, request, h.service.Stop)
}

func (h *Handler) retire(response http.ResponseWriter, request *http.Request) {
	h.lifecycle(response, request, h.service.Retire)
}

func (h *Handler) purge(response http.ResponseWriter, request *http.Request) {
	h.lifecycle(response, request, h.service.Purge)
}

func (h *Handler) lifecycle(
	response http.ResponseWriter,
	request *http.Request,
	command func(context.Context, application.LifecycleInput) (domain.LifecyclePlan, error),
) {
	idempotencyKey, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	result, err := command(request.Context(), application.LifecycleInput{
		AgentID: request.PathValue("agent_id"), IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationFrom(result.Operation))
}

func (h *Handler) updateNetworkPolicy(response http.ResponseWriter, request *http.Request) {
	idempotencyKey, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var body struct {
		Mode domain.NetworkMode `json:"mode"`
	}
	if !decodeJSON(response, request, &body) {
		return
	}
	result, err := h.service.UpdateNetworkPolicy(request.Context(), application.NetworkPolicyInput{
		AgentID: request.PathValue("agent_id"), NetworkMode: body.Mode,
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, operationFrom(result.Operation))
}

func (h *Handler) getOperation(response http.ResponseWriter, request *http.Request) {
	operation, err := h.service.GetOperation(request.Context(), request.PathValue("operation_id"))
	if err != nil {
		writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, operationFrom(operation))
}

type runtimeResponse struct {
	AgentID             string               `json:"agent_id"`
	ImageRef            string               `json:"image_ref"`
	NetworkMode         domain.NetworkMode   `json:"network_mode"`
	DesiredState        domain.DesiredState  `json:"desired_state"`
	Status              domain.RuntimeStatus `json:"status"`
	DesiredGeneration   uint64               `json:"desired_generation"`
	ObservedGeneration  uint64               `json:"observed_generation"`
	NetworkPolicyEpoch  uint64               `json:"network_policy_epoch"`
	ObservedPolicyEpoch uint64               `json:"observed_policy_epoch"`
	FailureCode         string               `json:"failure_code,omitempty"`
	FailureDetail       string               `json:"failure_detail,omitempty"`
	ResourceVersion     uint64               `json:"resource_version"`
	UpdatedAt           time.Time            `json:"updated_at"`
}

type operationResponse struct {
	OperationID string                 `json:"operation_id"`
	AgentID     string                 `json:"agent_id"`
	Kind        domain.OperationKind   `json:"kind"`
	Status      domain.OperationStatus `json:"status"`
	Generation  uint64                 `json:"generation"`
	ErrorCode   string                 `json:"error_code,omitempty"`
	ErrorDetail string                 `json:"error_detail,omitempty"`
	UpdatedAt   time.Time              `json:"updated_at"`
}

type problem struct {
	Type    string `json:"type"`
	Title   string `json:"title"`
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Detail  string `json:"detail,omitempty"`
	TraceID string `json:"trace_id,omitempty"`
}

func runtimeFrom(runtime domain.Runtime) runtimeResponse {
	return runtimeResponse{
		AgentID: runtime.AgentID, ImageRef: runtime.ImageRef, NetworkMode: runtime.NetworkMode,
		DesiredState: runtime.DesiredState, Status: runtime.Status,
		DesiredGeneration: runtime.DesiredGeneration, ObservedGeneration: runtime.ObservedGeneration,
		NetworkPolicyEpoch: runtime.NetworkPolicyEpoch, ObservedPolicyEpoch: runtime.ObservedPolicyEpoch,
		FailureCode: runtime.FailureCode, FailureDetail: runtime.FailureDetail,
		ResourceVersion: runtime.ResourceVersion, UpdatedAt: runtime.UpdatedAt,
	}
}

func operationFrom(operation domain.Operation) operationResponse {
	return operationResponse{
		OperationID: operation.ID, AgentID: operation.AgentID, Kind: operation.Kind,
		Status: operation.Status, Generation: operation.Generation,
		ErrorCode: operation.ErrorCode, ErrorDetail: operation.ErrorDetail,
		UpdatedAt: operation.UpdatedAt,
	}
}

func requireIdempotencyKey(response http.ResponseWriter, request *http.Request) (string, bool) {
	key := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if key == "" {
		writeProblem(response, request, http.StatusBadRequest, "invalid_request", "Idempotency-Key is required")
		return "", false
	}
	if utf8.RuneCountInString(key) > domain.MaxIdempotencyKeyCharacters {
		writeProblem(response, request, http.StatusBadRequest, "invalid_request", "Idempotency-Key is too long")
		return "", false
	}
	return key, true
}

func decodeJSON(response http.ResponseWriter, request *http.Request, destination any) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxRequestBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeProblem(response, request, http.StatusBadRequest, "invalid_json", err.Error())
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeProblem(response, request, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return false
	}
	return true
}

func writeServiceError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, application.ErrNotFound):
		writeProblem(response, request, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, domain.ErrInvalidArgument):
		writeProblem(response, request, http.StatusBadRequest, "invalid_request", err.Error())
	case errors.Is(err, domain.ErrIdempotencyConflict), errors.Is(err, domain.ErrGenerationFenced),
		errors.Is(err, domain.ErrConcurrentWrite):
		writeProblem(response, request, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, application.ErrRuntimeUnavailable), errors.Is(err, application.ErrWorkEpochStale):
		writeProblem(response, request, http.StatusConflict, "runtime_unavailable", err.Error())
	default:
		writeProblem(response, request, http.StatusInternalServerError, "internal_error", "runtime request failed")
	}
}

func writeProblem(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	code string,
	detail string,
) {
	traceID := ""
	if request != nil {
		spanContext := trace.SpanContextFromContext(request.Context())
		if spanContext.IsValid() {
			traceID = spanContext.TraceID().String()
		}
	}
	response.Header().Set("Content-Type", "application/problem+json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(problem{
		Type: "urn:antnest:runtime:" + code, Title: http.StatusText(status),
		Status: status, Code: code, Detail: detail, TraceID: traceID,
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
