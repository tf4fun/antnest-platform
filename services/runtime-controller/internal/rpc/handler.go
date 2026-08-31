package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/observation"
)

const maxRequestBytes = 1 << 20

var (
	rpcMeter          = otel.Meter("soft/antnest-platform/runtime-controller/rpc")
	watchTerminations = mustCounter(rpcMeter.Int64Counter("runtime.observation.watch.terminations"))
)

type Service interface {
	Status(context.Context) (control.Readiness, error)
	InitializeRuntime(context.Context, string, string, deployment.Configuration) (deployment.Operation, error)
	UpdateRuntime(context.Context, string, string, deployment.RuntimeRevision, deployment.Configuration) (deployment.Operation, error)
	DisableRuntime(context.Context, string, string, deployment.RuntimeRevision) (deployment.Operation, error)
	EnableRuntime(context.Context, string, string, deployment.RuntimeRevision, deployment.Configuration) (deployment.Operation, error)
	DeleteRuntime(context.Context, string, string, deployment.RuntimeRevision) (deployment.Operation, error)
	InspectRuntime(context.Context, string) (deployment.Environment, error)
	GetOperation(context.Context, string) (deployment.Operation, error)
	ListRuntimes(context.Context) ([]deployment.Environment, error)
	ListObservations(context.Context, uint64, int) ([]deployment.Observation, error)
}

type Handler struct {
	service   Service
	hub       *observation.Hub
	heartbeat time.Duration
	mux       *http.ServeMux
}

func NewHandler(service Service, hub *observation.Hub, heartbeat time.Duration) (*Handler, error) {
	if service == nil || hub == nil {
		return nil, fmt.Errorf("service and observation hub are required")
	}
	if heartbeat <= 0 {
		return nil, fmt.Errorf("SSE heartbeat must be positive")
	}
	handler := &Handler{service: service, hub: hub, heartbeat: heartbeat}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", handler.status)
	mux.HandleFunc("GET /internal/runtimes", handler.listRuntimes)
	mux.HandleFunc("GET /internal/runtimes/{agent_id}", handler.inspectRuntime)
	mux.HandleFunc("POST /internal/runtimes/{agent_id}/initialize", handler.initializeRuntime)
	mux.HandleFunc("POST /internal/runtimes/{agent_id}/update", handler.updateRuntime)
	mux.HandleFunc("POST /internal/runtimes/{agent_id}/disable", handler.disableRuntime)
	mux.HandleFunc("POST /internal/runtimes/{agent_id}/enable", handler.enableRuntime)
	mux.HandleFunc("POST /internal/runtimes/{agent_id}/delete", handler.deleteRuntime)
	mux.HandleFunc("GET /internal/runtime-operations/{request_id}", handler.getOperation)
	mux.HandleFunc("GET /internal/runtime-observations", handler.listObservations)
	mux.HandleFunc("GET /internal/runtime-observations/watch", handler.watchObservations)
	for _, pattern := range []string{
		"/status", "/internal/runtimes", "/internal/runtimes/{agent_id}",
		"/internal/runtimes/{agent_id}/initialize", "/internal/runtimes/{agent_id}/update",
		"/internal/runtimes/{agent_id}/disable", "/internal/runtimes/{agent_id}/enable",
		"/internal/runtimes/{agent_id}/delete", "/internal/runtime-operations/{request_id}",
		"/internal/runtime-observations", "/internal/runtime-observations/watch",
	} {
		mux.HandleFunc(pattern, handler.methodNotAllowed)
	}
	mux.HandleFunc("/", handler.notFound)
	handler.mux = mux
	return handler, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

type initializeRequest struct {
	Configuration deployment.Configuration `json:"configuration"`
}

type revisionRequest struct {
	ExpectedRevision deployment.RuntimeRevision `json:"expected_revision"`
}

type revisionConfigurationRequest struct {
	ExpectedRevision deployment.RuntimeRevision `json:"expected_revision"`
	Configuration    deployment.Configuration   `json:"configuration"`
}

type readinessResponse struct {
	Status string `json:"status"`
	Live   bool   `json:"live"`
	Ready  bool   `json:"ready"`
	control.Readiness
}

type runtimesResponse struct {
	Runtimes []deployment.Environment `json:"runtimes"`
}

type observationsResponse struct {
	Observations []deployment.Observation `json:"observations"`
	NextSequence uint64                   `json:"next_sequence"`
}

type errorResponse struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (h *Handler) status(response http.ResponseWriter, request *http.Request) {
	status, err := h.service.Status(request.Context())
	label := "ready"
	code := http.StatusOK
	if err != nil || !status.Ready() {
		label = "not_ready"
		code = http.StatusServiceUnavailable
	}
	writeJSON(response, code, readinessResponse{
		Status: label, Live: true, Ready: status.Ready(), Readiness: status,
	})
}

func (h *Handler) listRuntimes(response http.ResponseWriter, request *http.Request) {
	values, err := h.service.ListRuntimes(request.Context())
	if err != nil {
		writeError(response, err)
		return
	}
	if values == nil {
		values = []deployment.Environment{}
	}
	writeJSON(response, http.StatusOK, runtimesResponse{Runtimes: values})
}

func (h *Handler) initializeRuntime(response http.ResponseWriter, request *http.Request) {
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input initializeRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	operation, err := h.service.InitializeRuntime(
		request.Context(), requestID, request.PathValue("agent_id"), input.Configuration,
	)
	writeOperation(response, request.Context(), operation, err)
}

func (h *Handler) inspectRuntime(response http.ResponseWriter, request *http.Request) {
	inspection, err := h.service.InspectRuntime(request.Context(), request.PathValue("agent_id"))
	if err != nil {
		if errors.Is(err, control.ErrNotFound) {
			writeJSON(response, http.StatusNotFound, errorResponse{
				Code: "runtime_not_found", Message: "Runtime environment was not found", Retryable: false,
			})
			return
		}
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, inspection)
}

func (h *Handler) updateRuntime(response http.ResponseWriter, request *http.Request) {
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input revisionConfigurationRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	operation, err := h.service.UpdateRuntime(
		request.Context(), requestID, request.PathValue("agent_id"),
		input.ExpectedRevision, input.Configuration,
	)
	writeOperation(response, request.Context(), operation, err)
}

func (h *Handler) disableRuntime(response http.ResponseWriter, request *http.Request) {
	h.revisionOnly(response, request, h.service.DisableRuntime)
}

func (h *Handler) enableRuntime(response http.ResponseWriter, request *http.Request) {
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input revisionConfigurationRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	operation, err := h.service.EnableRuntime(
		request.Context(), requestID, request.PathValue("agent_id"),
		input.ExpectedRevision, input.Configuration,
	)
	writeOperation(response, request.Context(), operation, err)
}

func (h *Handler) deleteRuntime(response http.ResponseWriter, request *http.Request) {
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input revisionRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	operation, err := h.service.DeleteRuntime(
		request.Context(), requestID, request.PathValue("agent_id"), input.ExpectedRevision,
	)
	writeOperation(response, request.Context(), operation, err)
}

func (h *Handler) revisionOnly(
	response http.ResponseWriter,
	request *http.Request,
	execute func(context.Context, string, string, deployment.RuntimeRevision) (deployment.Operation, error),
) {
	requestID, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	var input revisionRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, err)
		return
	}
	operation, err := execute(
		request.Context(), requestID, request.PathValue("agent_id"), input.ExpectedRevision,
	)
	writeOperation(response, request.Context(), operation, err)
}

func (h *Handler) getOperation(response http.ResponseWriter, request *http.Request) {
	operation, err := h.service.GetOperation(request.Context(), request.PathValue("request_id"))
	if err != nil {
		if errors.Is(err, control.ErrNotFound) {
			writeJSON(response, http.StatusNotFound, errorResponse{
				Code: "operation_not_found", Message: "Runtime operation was not found", Retryable: false,
			})
			return
		}
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, operation)
}

func (h *Handler) listObservations(response http.ResponseWriter, request *http.Request) {
	after, limit, err := observationCursor(request)
	if err != nil {
		writeError(response, err)
		return
	}
	values, err := h.service.ListObservations(request.Context(), after, limit)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, observationsResponse{
		Observations: values, NextSequence: nextSequence(after, values),
	})
}

func (h *Handler) watchObservations(response http.ResponseWriter, request *http.Request) {
	termination := "client_closed"
	ctx := request.Context()
	defer func() {
		attributes := []attribute.KeyValue{attribute.String("antnest.watch.termination", termination)}
		watchTerminations.Add(ctx, 1, metric.WithAttributes(attributes...))
	}()
	after, _, err := observationCursor(request)
	if err != nil {
		termination = "invalid_request"
		writeError(response, err)
		return
	}
	notifications, cancel := h.hub.Subscribe()
	defer cancel()
	initial, err := h.service.ListObservations(ctx, after, 500)
	if err != nil {
		termination = "initial_read_error"
		writeError(response, err)
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(response)
	if err := controller.Flush(); err != nil {
		termination = "delivery_error"
		return
	}
	ticker := time.NewTicker(h.heartbeat)
	defer ticker.Stop()
	cursor, err := writeObservationValues(response, controller, after, initial)
	if err != nil {
		termination = "delivery_error"
		return
	}
	for {
		var writeErr error
		cursor, writeErr = h.writeAvailable(response, request, controller, cursor)
		if writeErr != nil {
			termination = "delivery_error"
			return
		}
		select {
		case <-request.Context().Done():
			termination = "client_closed"
			return
		case <-notifications:
		case <-ticker.C:
			if _, err := io.WriteString(response, ": keepalive\n\n"); err != nil {
				termination = "delivery_error"
				return
			}
			if err := controller.Flush(); err != nil {
				termination = "delivery_error"
				return
			}
		}
	}
}

func (*Handler) methodNotAllowed(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusMethodNotAllowed, errorResponse{
		Code: "method_not_allowed", Message: "method is not allowed for this route", Retryable: false,
	})
}

func (*Handler) notFound(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusNotFound, errorResponse{
		Code: "route_not_found", Message: "route was not found", Retryable: false,
	})
}

func (h *Handler) writeAvailable(
	response http.ResponseWriter,
	request *http.Request,
	controller *http.ResponseController,
	cursor uint64,
) (uint64, error) {
	for {
		values, err := h.service.ListObservations(request.Context(), cursor, 500)
		if err != nil {
			return cursor, err
		}
		previous := cursor
		cursor, err = writeObservationValues(response, controller, cursor, values)
		if err != nil {
			return cursor, err
		}
		advanced := cursor != previous
		if len(values) < 500 || !advanced {
			return cursor, nil
		}
	}
}

func writeObservationValues(
	response http.ResponseWriter,
	controller *http.ResponseController,
	cursor uint64,
	values []deployment.Observation,
) (uint64, error) {
	advanced := false
	for _, value := range values {
		if value.Sequence <= cursor {
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return cursor, err
		}
		if _, err := fmt.Fprintf(response, "id: %d\nevent: runtime_observation\ndata: %s\n\n", value.Sequence, encoded); err != nil {
			return cursor, err
		}
		cursor = value.Sequence
		advanced = true
	}
	if advanced {
		if err := controller.Flush(); err != nil {
			return cursor, err
		}
	}
	return cursor, nil
}

func requireIdempotencyKey(response http.ResponseWriter, request *http.Request) (string, bool) {
	value := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if value == "" {
		writeJSON(response, http.StatusBadRequest, errorResponse{
			Code: "idempotency_key_required", Message: "Idempotency-Key is required", Retryable: false,
		})
		return "", false
	}
	return value, true
}

func observationCursor(request *http.Request) (uint64, int, error) {
	after, err := parseUintQuery(request, "after_sequence", 0)
	if err != nil {
		return 0, 0, err
	}
	if after > math.MaxInt64 {
		return 0, 0, fmt.Errorf("%w: after_sequence exceeds the persistence range", control.ErrInvalidRequest)
	}
	limit64, err := parseUintQuery(request, "limit", 100)
	if err != nil || limit64 == 0 || limit64 > 500 {
		return 0, 0, fmt.Errorf("%w: limit must be between 1 and 500", control.ErrInvalidRequest)
	}
	return after, int(limit64), nil
}

func parseUintQuery(request *http.Request, key string, fallback uint64) (uint64, error) {
	raw := strings.TrimSpace(request.URL.Query().Get(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: %s must be an unsigned integer", control.ErrInvalidRequest, key)
	}
	return value, nil
}

func nextSequence(after uint64, values []deployment.Observation) uint64 {
	if len(values) == 0 {
		return after
	}
	return values[len(values)-1].Sequence
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: invalid JSON body", control.ErrInvalidRequest)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: request body must contain one JSON value", control.ErrInvalidRequest)
	}
	return nil
}

func writeOperation(
	response http.ResponseWriter, ctx context.Context, operation deployment.Operation, err error,
) {
	result := string(operation.State)
	if err != nil {
		result = "error"
	}
	attributes := []any{
		"operation_id", operation.RequestID, "operation_kind", operation.Kind,
		"agent_id", operation.AgentID, "runtime_revision", operation.RuntimeRevision,
		"result", result, "error_code", operation.ErrorCode,
	}
	if operation.Inspection != nil {
		attributes = append(attributes,
			"runtime_execution_id", operation.Inspection.RuntimeExecutionID,
		)
	}
	slog.InfoContext(ctx, "Runtime deployment operation finished", attributes...)
	if err != nil {
		writeError(response, err)
		return
	}
	switch operation.State {
	case deployment.OperationCompleted:
		writeJSON(response, http.StatusOK, operation)
	case deployment.OperationRunning, deployment.OperationUnknown:
		writeJSON(response, http.StatusAccepted, operation)
	case deployment.OperationFailed:
		writeOperationError(response, operation)
	default:
		writeError(response, errors.New("operation returned an invalid state"))
	}
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func writeOperationError(response http.ResponseWriter, operation deployment.Operation) {
	code := operation.ErrorCode
	message := "deployment operation failed"
	status := http.StatusConflict
	retryable := false
	switch code {
	case "runtime_drift":
		message = "managed Runtime has different immutable identity"
	case "storage_in_use":
		message = "Agent storage is still used by a managed Runtime"
	case "storage_ownership_conflict":
		message = "workspace volume is not owned by this Agent"
	case "storage_not_found":
		message = "required Runtime storage is not available"
		status = http.StatusNotFound
	case "platform_unavailable":
		message = "deployment platform did not return a conclusive result"
		status = http.StatusServiceUnavailable
		retryable = true
	case "runtime_not_found":
		message = "managed Runtime was not found"
		status = http.StatusNotFound
	default:
		code = "operation_failed"
		status = http.StatusInternalServerError
	}
	writeJSON(response, status, errorResponse{Code: code, Message: message, Retryable: retryable})
}

func writeError(response http.ResponseWriter, err error) {
	result := errorResponse{Code: "internal_error", Message: "internal service error", Retryable: true}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, control.ErrInvalidRequest), errors.Is(err, deployment.ErrInvalid):
		status = http.StatusBadRequest
		result = errorResponse{Code: "invalid_request", Message: "request is invalid", Retryable: false}
	case errors.Is(err, control.ErrRequestConflict):
		status = http.StatusConflict
		result = errorResponse{Code: "request_id_conflict", Message: "request ID was already used for different input", Retryable: false}
	case errors.Is(err, control.ErrAgentMutationInProgress):
		status = http.StatusConflict
		result = errorResponse{Code: "agent_mutation_in_progress", Message: "another Agent mutation is still in progress", Retryable: true}
	case errors.Is(err, control.ErrMutationLockLost):
		status = http.StatusServiceUnavailable
		result = errorResponse{Code: "mutation_lock_lost", Message: "Agent mutation coordination was interrupted", Retryable: true}
	case errors.Is(err, control.ErrLifecycleConflict):
		status = http.StatusConflict
		result = errorResponse{Code: "runtime_lifecycle_conflict", Message: "operation is not valid for the current Runtime lifecycle state", Retryable: false}
	case errors.Is(err, control.ErrRevisionConflict):
		status = http.StatusConflict
		result = errorResponse{Code: "runtime_revision_conflict", Message: "Runtime revision is stale", Retryable: false}
	case errors.Is(err, control.ErrDrift):
		status = http.StatusConflict
		result = errorResponse{Code: "runtime_drift", Message: "Runtime platform state differs from the controller record", Retryable: false}
	case errors.Is(err, deployment.ErrIdentityConflict):
		status = http.StatusConflict
		result = errorResponse{Code: "runtime_drift", Message: "managed Runtime has different immutable identity", Retryable: false}
	case errors.Is(err, control.ErrNotFound):
		status = http.StatusNotFound
		result = errorResponse{Code: "runtime_not_found", Message: "Runtime environment was not found", Retryable: false}
	case errors.Is(err, context.DeadlineExceeded):
		status = http.StatusGatewayTimeout
		result = errorResponse{Code: "deadline_exceeded", Message: "operation deadline exceeded", Retryable: true}
	}
	writeJSON(response, status, result)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
