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
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

const maxRequestBytes = 1 << 20

var ErrServerShutdown = errors.New("runtime controller server is shutting down")

var (
	rpcMeter          = otel.Meter("github.com/tf4fun/antnest-platform/runtime-controller/rpc")
	rpcTracer         = otel.Tracer("github.com/tf4fun/antnest-platform/runtime-controller/rpc")
	lifecycleCalls    = mustCounter(rpcMeter.Int64Counter("runtime.lifecycle.operations"))
	lifecycleDuration = mustHistogram(rpcMeter.Float64Histogram(
		"runtime.lifecycle.operation.duration", metric.WithUnit("s"),
	))
	watchConnections  = mustCounter(rpcMeter.Int64Counter("runtime.observation.watch.connections"))
	watchActive       = mustUpDownCounter(rpcMeter.Int64UpDownCounter("runtime.observation.watch.active"))
	watchTerminations = mustCounter(rpcMeter.Int64Counter("runtime.observation.watch.terminations"))
)

type Service interface {
	Status(context.Context) (control.Readiness, error)
	ResolveImage(context.Context, string) (platform.ImageResolution, error)
	InitializeRuntime(context.Context, string, string, deployment.Configuration) (deployment.Operation, error)
	UpdateRuntime(context.Context, string, string, deployment.RuntimeRevision, deployment.Configuration) (deployment.Operation, error)
	DisableRuntime(context.Context, string, string, deployment.RuntimeRevision) (deployment.Operation, error)
	EnableRuntime(context.Context, string, string, deployment.RuntimeRevision, deployment.Configuration) (deployment.Operation, error)
	DeleteRuntime(context.Context, string, string, deployment.RuntimeRevision) (deployment.Operation, error)
	InspectRuntime(context.Context, string) (deployment.Environment, error)
	GetOperation(context.Context, string) (deployment.Operation, error)
	ListRuntimes(context.Context) ([]deployment.Environment, error)
	ListObservations(context.Context, uint64, int) (deployment.ObservationWindow, error)
}

type Handler struct {
	security         Security
	service          Service
	skillPreparation SkillPreparationService
	hub              *observation.Hub
	heartbeat        time.Duration
	requestTimeout   time.Duration
	mux              *http.ServeMux
}

type SkillPreparationService interface {
	Prepare(context.Context, string, string, skillset.PrepareRequest) (skillset.PreparationReceipt, error)
	Get(context.Context, string, string, string) (skillset.PreparationReceipt, error)
	Release(context.Context, string, string, string, string) error
}

func NewHandler(
	service Service, hub *observation.Hub, heartbeat, requestTimeout time.Duration, security Security,
	skillPreparations ...SkillPreparationService,
) (*Handler, error) {
	if service == nil || hub == nil {
		return nil, fmt.Errorf("service and observation hub are required")
	}
	if security.Authentication == nil {
		return nil, fmt.Errorf("controller workload authentication is required")
	}
	if heartbeat <= 0 {
		return nil, fmt.Errorf("SSE heartbeat must be positive")
	}
	if requestTimeout <= 0 {
		return nil, fmt.Errorf("RPC request timeout must be positive")
	}
	handler := &Handler{
		service: service, hub: hub, heartbeat: heartbeat, requestTimeout: requestTimeout,
		security: security,
	}
	if len(skillPreparations) > 1 {
		return nil, fmt.Errorf("only one Skill preparation service is supported")
	}
	if len(skillPreparations) == 1 {
		handler.skillPreparation = skillPreparations[0]
	}
	mux := http.NewServeMux()
	registerRPC := func(pattern string, endpoint http.HandlerFunc) {
		mux.Handle(pattern, telemetry.RPCHandler(pattern, endpoint))
	}
	mux.HandleFunc("GET /status", handler.status)
	registerRPC("GET /internal/runtime-images/resolve", handler.resolveImage)
	registerRPC("GET /internal/runtimes", handler.listRuntimes)
	registerRPC("GET /internal/runtimes/{agent_id}", handler.inspectRuntime)
	registerRPC("POST /internal/runtimes/{agent_id}/connection", handler.resolveRuntimeConnection)
	registerRPC("POST /internal/runtimes/{agent_id}/skill-sets/prepare", handler.prepareSkillSet)
	registerRPC("GET /internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}", handler.getSkillPreparation)
	registerRPC("POST /internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}/release", handler.releaseSkillPreparation)
	registerRPC("POST /internal/runtimes/{agent_id}/initialize", handler.initializeRuntime)
	registerRPC("POST /internal/runtimes/{agent_id}/update", handler.updateRuntime)
	registerRPC("POST /internal/runtimes/{agent_id}/disable", handler.disableRuntime)
	registerRPC("POST /internal/runtimes/{agent_id}/enable", handler.enableRuntime)
	registerRPC("POST /internal/runtimes/{agent_id}/delete", handler.deleteRuntime)
	registerRPC("GET /internal/runtime-operations/{request_id}", handler.getOperation)
	registerRPC("GET /internal/runtime-observations", handler.listObservations)
	mux.HandleFunc("GET /internal/runtime-observations/watch", handler.watchObservations)
	for _, pattern := range []string{
		"/internal/runtime-images/resolve",
		"/status", "/internal/runtimes", "/internal/runtimes/{agent_id}",
		"/internal/runtimes/{agent_id}/connection",
		"/internal/runtimes/{agent_id}/initialize", "/internal/runtimes/{agent_id}/update",
		"/internal/runtimes/{agent_id}/disable", "/internal/runtimes/{agent_id}/enable",
		"/internal/runtimes/{agent_id}/delete", "/internal/runtime-operations/{request_id}",
		"/internal/runtime-observations", "/internal/runtime-observations/watch",
		"/internal/runtimes/{agent_id}/skill-sets/prepare",
		"/internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}",
		"/internal/runtimes/{agent_id}/skill-sets/preparations/{request_id}/release",
	} {
		mux.HandleFunc(pattern, handler.methodNotAllowed)
	}
	mux.HandleFunc("/", handler.notFound)
	handler.mux = mux
	return handler, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if strings.HasSuffix(request.URL.Path, "/connection") {
		response.Header().Set("Cache-Control", "no-store")
		telemetry.SuppressRPCContent(request.Context())
	}
	if !h.authenticate(response, request) {
		return
	}
	if request.URL.Path == "/internal/runtime-observations/watch" {
		h.mux.ServeHTTP(response, request)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	bounded := request.WithContext(ctx)
	defer func() { request.Pattern = bounded.Pattern }()
	h.mux.ServeHTTP(response, bounded)
	// Outer observability middleware reads routing metadata after this handler.
	request.Pattern = bounded.Pattern
}

func (h *Handler) status(response http.ResponseWriter, request *http.Request) {
	status, err := h.service.Status(request.Context())
	label := "ready"
	code := http.StatusOK
	if err != nil || !status.Ready() {
		label = "not_ready"
		code = http.StatusServiceUnavailable
		message := "Runtime Controller readiness is unavailable"
		if status.LocalReady() && !status.MonitorReady {
			message = "Platform observation monitor is not ready"
		}
		telemetry.ObserveError(response, err, "readiness", "not_ready", message)
	}
	writeJSON(response, code, readinessFromDomain(label, status))
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
	writeJSON(response, http.StatusOK, runtimesResponse{Runtimes: runtimesFromDomain(values)})
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
	call := beginLifecycle(request, deployment.OperationInitializeRuntime, requestID)
	operation, err := h.service.InitializeRuntime(
		call.context, requestID, request.PathValue("agent_id"), input.Configuration.domain(),
	)
	writeOperation(response, call, operation, err)
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
	writeJSON(response, http.StatusOK, runtimeInspectionFromDomain(inspection))
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
	call := beginLifecycle(request, deployment.OperationUpdateRuntime, requestID)
	operation, err := h.service.UpdateRuntime(
		call.context, requestID, request.PathValue("agent_id"),
		input.ExpectedRevision, input.Configuration.domain(),
	)
	writeOperation(response, call, operation, err)
}

func (h *Handler) disableRuntime(response http.ResponseWriter, request *http.Request) {
	h.revisionOnly(response, request, deployment.OperationDisableRuntime, h.service.DisableRuntime)
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
	call := beginLifecycle(request, deployment.OperationEnableRuntime, requestID)
	operation, err := h.service.EnableRuntime(
		call.context, requestID, request.PathValue("agent_id"),
		input.ExpectedRevision, input.Configuration.domain(),
	)
	writeOperation(response, call, operation, err)
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
	call := beginLifecycle(request, deployment.OperationDeleteRuntime, requestID)
	operation, err := h.service.DeleteRuntime(
		call.context, requestID, request.PathValue("agent_id"), input.ExpectedRevision,
	)
	writeOperation(response, call, operation, err)
}

func (h *Handler) revisionOnly(
	response http.ResponseWriter,
	request *http.Request,
	kind deployment.OperationKind,
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
	call := beginLifecycle(request, kind, requestID)
	operation, err := execute(
		call.context, requestID, request.PathValue("agent_id"), input.ExpectedRevision,
	)
	writeOperation(response, call, operation, err)
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
	writeJSON(response, http.StatusOK, operationFromDomain(operation))
}

func (h *Handler) listObservations(response http.ResponseWriter, request *http.Request) {
	after, limit, err := observationCursor(request)
	if err != nil {
		writeError(response, err)
		return
	}
	window, err := h.service.ListObservations(request.Context(), after, limit)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, observationsResponse{
		Observations:   observationsFromDomain(window.Observations),
		OldestSequence: window.OldestSequence, LatestSequence: window.LatestSequence,
		NextSequence: nextSequence(after, window.Observations),
	})
}

func (h *Handler) watchObservations(response http.ResponseWriter, request *http.Request) {
	termination := "client_closed"
	ctx := request.Context()
	streamStarted := false
	started := time.Now()
	defer func() {
		metricCtx := context.WithoutCancel(ctx)
		attributes := []attribute.KeyValue{attribute.String("antnest.watch.termination", termination)}
		watchTerminations.Add(metricCtx, 1, metric.WithAttributes(attributes...))
		if streamStarted {
			watchActive.Add(metricCtx, -1)
			slog.InfoContext(metricCtx, "Runtime observation Watch closed",
				"component", "observation_watch", "result", termination,
				"duration", time.Since(started))
		}
		if termination == "delivery_error" {
			telemetry.ObserveError(response, nil, "observation_watch", "delivery_error", "Observation delivery ended after a read or write failure")
		}
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
	streamStarted = true
	watchConnections.Add(ctx, 1)
	watchActive.Add(ctx, 1)
	slog.InfoContext(ctx, "Runtime observation Watch started",
		"component", "observation_watch", "result", "connected")
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
	cursor, err := writeObservationValues(response, controller, after, initial.Observations)
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
		case <-ctx.Done():
			termination = watchTermination(ctx)
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
		window, err := h.service.ListObservations(request.Context(), cursor, 500)
		if err != nil {
			return cursor, err
		}
		previous := cursor
		cursor, err = writeObservationValues(response, controller, cursor, window.Observations)
		if err != nil {
			return cursor, err
		}
		advanced := cursor != previous
		if len(window.Observations) < 500 || !advanced {
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
		encoded, err := json.Marshal(observationFromDomain(value))
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
	raw, err := io.ReadAll(request.Body)
	if err != nil || serviceauth.DecodeObject(raw, target) != nil {
		return control.ErrInvalidRequest
	}
	observeRequest(request, target)
	return nil
}

func writeOperation(
	response http.ResponseWriter,
	call lifecycleCall,
	operation deployment.Operation,
	err error,
) {
	defer finishLifecycle(call, operation, err)
	result := string(operation.State)
	if err != nil {
		result = "error"
	}
	attributes := []any{
		"operation_id", telemetry.SafeValue(valueOr(operation.RequestID, call.requestID)), "operation_kind", call.kind,
		"agent_id", telemetry.SafeValue(valueOr(operation.AgentID, call.agentID)),
		"target_revision", operation.RuntimeRevision,
		"result", result, "error_code", operation.ErrorCode,
	}
	if operation.Inspection != nil {
		attributes = append(attributes,
			"runtime_execution_id", operation.Inspection.RuntimeExecutionID,
		)
	}
	slog.InfoContext(call.context, "Runtime deployment operation finished", attributes...)
	if err != nil {
		writeError(response, err)
		return
	}
	switch operation.State {
	case deployment.OperationCompleted:
		writeJSON(response, http.StatusOK, operationFromDomain(operation))
	case deployment.OperationRunning, deployment.OperationUnknown:
		writeJSON(response, http.StatusAccepted, operationFromDomain(operation))
	case deployment.OperationFailed:
		writeOperationError(response, operation)
	default:
		writeError(response, errors.New("operation returned an invalid state"))
	}
}

type lifecycleCall struct {
	context   context.Context
	span      trace.Span
	started   time.Time
	kind      deployment.OperationKind
	requestID string
	agentID   string
}

func beginLifecycle(
	request *http.Request, kind deployment.OperationKind, requestID string,
) lifecycleCall {
	ctx, span := rpcTracer.Start(request.Context(), "runtime.lifecycle."+string(kind))
	agentID := request.PathValue("agent_id")
	span.SetAttributes(
		attribute.String("antnest.agent.id", telemetry.SafeValue(agentID)),
		attribute.String("antnest.operation.id", telemetry.SafeValue(requestID)),
		attribute.String("antnest.operation.kind", string(kind)),
	)
	return lifecycleCall{
		context: ctx, span: span, started: time.Now(), kind: kind,
		requestID: requestID, agentID: agentID,
	}
}

func finishLifecycle(
	call lifecycleCall,
	operation deployment.Operation,
	err error,
) {
	result := string(operation.State)
	errorClass := operation.ErrorCode
	if err != nil {
		result = "error"
		errorClass = lifecycleErrorClass(err)
		if classifyError(err).status >= 500 {
			// The shared RPC error writer records the detailed cause on SERVER.
			call.span.SetStatus(codes.Error, errorClass)
		} else {
			call.span.SetAttributes(attribute.String("antnest.outcome", "rejected"))
		}
	} else if operation.State == deployment.OperationFailed || operation.State == deployment.OperationUnknown {
		call.span.SetStatus(codes.Error, errorClass)
	}
	if result == "" {
		result = "error"
	}
	if errorClass == "" {
		errorClass = "none"
	}
	spanAttributes := []attribute.KeyValue{
		attribute.String("antnest.operation.kind", string(call.kind)),
		attribute.String("antnest.result", result),
		attribute.String("antnest.error.class", errorClass),
	}
	if operation.RequestID != "" {
		spanAttributes = append(spanAttributes, attribute.String("antnest.operation.id", telemetry.SafeValue(operation.RequestID)))
	}
	if operation.AgentID != "" {
		spanAttributes = append(spanAttributes, attribute.String("antnest.agent.id", telemetry.SafeValue(operation.AgentID)))
	}
	if operation.RuntimeRevision != "" {
		spanAttributes = append(spanAttributes,
			attribute.String("antnest.runtime.target_revision", telemetry.SafeValue(string(operation.RuntimeRevision))),
			attribute.String("antnest.runtime.revision", telemetry.SafeValue(string(operation.RuntimeRevision))))
	}
	call.span.SetAttributes(spanAttributes...)
	call.span.End()
	metricAttributes := []attribute.KeyValue{
		attribute.String("antnest.operation.kind", string(call.kind)),
		attribute.String("antnest.result", result),
		attribute.String("antnest.error.class", errorClass),
	}
	metricCtx := context.WithoutCancel(call.context)
	lifecycleCalls.Add(metricCtx, 1, metric.WithAttributes(metricAttributes...))
	lifecycleDuration.Record(metricCtx, time.Since(call.started).Seconds(), metric.WithAttributes(metricAttributes...))
}

func valueOr(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func lifecycleErrorClass(err error) string {
	return classifyError(err).response.Code
}

func watchTermination(ctx context.Context) string {
	if errors.Is(context.Cause(ctx), ErrServerShutdown) {
		return "server_shutdown"
	}
	return "client_closed"
}

func mustCounter(instrument metric.Int64Counter, err error) metric.Int64Counter {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustHistogram(instrument metric.Float64Histogram, err error) metric.Float64Histogram {
	if err != nil {
		panic(err)
	}
	return instrument
}

func mustUpDownCounter(instrument metric.Int64UpDownCounter, err error) metric.Int64UpDownCounter {
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
	case "runtime_not_ready":
		// Retain the diagnosis when replaying operations from before creation/readiness separation.
		message = "Runtime did not become ready; check its startup configuration and required MCP processes"
		status = http.StatusInternalServerError
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

type errorDescriptor struct {
	status   int
	response errorResponse
}

func classifyError(err error) errorDescriptor {
	if descriptor, ok := classifyImageError(err); ok {
		return descriptor
	}
	result := errorDescriptor{
		status: http.StatusInternalServerError,
		response: errorResponse{
			Code: "internal_error", Message: "internal service error", Retryable: true,
		},
	}
	var cursorExpired *control.ObservationCursorExpiredError
	if errors.As(err, &cursorExpired) {
		reset := cursorExpired.ResetSequence
		return errorDescriptor{
			status: http.StatusGone,
			response: errorResponse{
				Code:      "observation_cursor_expired",
				Message:   "observation cursor is outside the retained journal",
				Retryable: false, ResetSequence: &reset,
			},
		}
	}
	switch {
	case errors.Is(err, control.ErrInvalidRequest), errors.Is(err, deployment.ErrInvalid):
		result.status = http.StatusBadRequest
		result.response = errorResponse{Code: "invalid_request", Message: "request is invalid", Retryable: false}
	case errors.Is(err, control.ErrRequestConflict):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "request_id_conflict", Message: "request ID was already used for different input", Retryable: false}
	case errors.Is(err, control.ErrAgentMutationInProgress):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "agent_mutation_in_progress", Message: "another Agent mutation is still in progress", Retryable: true}
	case errors.Is(err, control.ErrMutationLockLost):
		result.status = http.StatusServiceUnavailable
		result.response = errorResponse{Code: "mutation_lock_lost", Message: "Agent mutation coordination was interrupted", Retryable: true}
	case errors.Is(err, control.ErrLifecycleConflict):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "runtime_lifecycle_conflict", Message: "operation is not valid for the current Runtime lifecycle state", Retryable: false}
	case errors.Is(err, control.ErrRevisionConflict):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "runtime_revision_conflict", Message: "Runtime revision is stale", Retryable: false}
	case errors.Is(err, control.ErrPreparedSkillSetInvalidated):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "prepared_skill_set_invalidated", Message: "prepared Skill set is unavailable or invalidated", Retryable: false}
	case errors.Is(err, control.ErrSkillPreflightUnavailable):
		result.status = http.StatusServiceUnavailable
		result.response = errorResponse{Code: "skill_preflight_unavailable", Message: "prepared Skill volume inspection is unavailable", Retryable: true}
	case errors.Is(err, repositoryport.ErrSkillCleanupInProgress):
		result.status = http.StatusServiceUnavailable
		result.response = errorResponse{Code: "skill_cleanup_in_progress", Message: "Skill set cleanup is in progress", Retryable: true}
	case errors.Is(err, repositoryport.ErrSkillPreparationClosed):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "skill_preparation_closed", Message: "Agent Skill preparation is closed", Retryable: false}
	case errors.Is(err, control.ErrDrift):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "runtime_drift", Message: "Runtime platform state differs from the controller record", Retryable: false}
	case errors.Is(err, deployment.ErrIdentityConflict):
		result.status = http.StatusConflict
		result.response = errorResponse{Code: "runtime_drift", Message: "managed Runtime has different immutable identity", Retryable: false}
	case errors.Is(err, control.ErrNotFound):
		result.status = http.StatusNotFound
		result.response = errorResponse{Code: "runtime_not_found", Message: "Runtime environment was not found", Retryable: false}
	case errors.Is(err, context.DeadlineExceeded):
		result.status = http.StatusGatewayTimeout
		result.response = errorResponse{Code: "deadline_exceeded", Message: "operation deadline exceeded", Retryable: true}
	}
	return result
}

func writeError(response http.ResponseWriter, err error) {
	descriptor := classifyError(err)
	if descriptor.status >= 500 {
		telemetry.ObserveError(response, err, "rpc", descriptor.response.Code, descriptor.response.Message)
	}
	writeJSON(response, descriptor.status, descriptor.response)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	observeResponse(response, value)
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
