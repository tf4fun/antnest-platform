package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

type workspaceStateResponse struct {
	AgentID         string                            `json:"agent_id"`
	Availability    application.WorkspaceAvailability `json:"availability"`
	AccessAllowed   bool                              `json:"access_allowed"`
	AgentRevision   int64                             `json:"agent_revision"`
	ActiveSessionID *string                           `json:"active_session_id"`
}

func workspaceStatePayload(state application.WorkspaceAgentState) workspaceStateResponse {
	return workspaceStateResponse{
		AgentID: state.AgentID, Availability: state.Availability, AccessAllowed: state.AccessAllowed,
		AgentRevision: state.AgentRevision, ActiveSessionID: optionalString(state.ActiveSessionID),
	}
}

func workspaceStateScope(response http.ResponseWriter, request *http.Request) (application.WorkspaceStateInput, bool) {
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}, "principal_id": {}})
	if !ok {
		return application.WorkspaceStateInput{}, false
	}
	input := application.WorkspaceStateInput{
		AgentID: request.PathValue("agent_id"), OrganizationID: query.Get("organization_id"),
		PrincipalID: query.Get("principal_id"),
	}
	if strings.TrimSpace(input.OrganizationID) == "" || strings.TrimSpace(input.PrincipalID) == "" || request.Header.Get("Last-Event-ID") != "" {
		writeError(response, http.StatusBadRequest, "invalid_request", "workspace scope is required and replay cursors are unsupported", false)
		return application.WorkspaceStateInput{}, false
	}
	return input, true
}

func (h *handler) getWorkspaceState(response http.ResponseWriter, request *http.Request) {
	input, ok := workspaceStateScope(response, request)
	if !ok {
		return
	}
	state, err := h.queries.GetWorkspaceAgentState(request.Context(), input)
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeJSON(response, http.StatusOK, workspaceStatePayload(state))
}

func (h *handler) watchWorkspaceState(response http.ResponseWriter, request *http.Request) {
	input, ok := workspaceStateScope(response, request)
	if !ok {
		return
	}
	ctx := request.Context()
	attributes := []attribute.KeyValue{attribute.String("antnest.event_watch.scope", "workspace_state")}
	eventWatchConnections.Add(ctx, 1, metric.WithAttributes(attributes...))
	result := "completed"
	defer func() {
		eventWatchConnections.Add(ctx, -1, metric.WithAttributes(attributes...))
		eventWatchDisconnects.Add(ctx, 1, metric.WithAttributes(append(attributes, attribute.String("antnest.result", result))...))
	}()
	stream := workspaceStateStream{response: response, controller: http.NewResponseController(response)}
	err := stream.setDeadline(time.Time{})
	if err == nil {
		err = h.queries.WatchWorkspaceAgentState(ctx, input, stream.emit)
	}
	if err == nil {
		return
	}
	if ctx.Err() != nil {
		result = "client_cancel"
		return
	}
	result = "error"
	trace.SpanFromContext(ctx).SetStatus(codes.Error, "workspace_state_watch_failed")
	if !stream.started {
		writeServiceError(ctx, response, err)
		return
	}
	slog.WarnContext(ctx, "Workspace state watch ended", "error_class", "workspace_state_watch_failed")
}

type workspaceStateStream struct {
	response   http.ResponseWriter
	controller *http.ResponseController
	started    bool
}

func (stream *workspaceStateStream) setDeadline(deadline time.Time) error {
	err := stream.controller.SetWriteDeadline(deadline)
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

func (stream *workspaceStateStream) emit(state application.WorkspaceAgentState) error {
	payload, err := json.Marshal(workspaceStatePayload(state))
	if err != nil {
		return fmt.Errorf("encode workspace state: %w", err)
	}
	if err := stream.setDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if !stream.started {
		stream.response.Header().Set("Content-Type", "text/event-stream")
		stream.response.Header().Set("Cache-Control", "no-cache, no-store")
		stream.response.Header().Set("X-Accel-Buffering", "no")
		stream.response.WriteHeader(http.StatusOK)
		stream.started = true
	}
	if _, err := fmt.Fprintf(stream.response, "event: workspace_state\ndata: %s\n\n", payload); err != nil {
		return err
	}
	if err := stream.controller.Flush(); err != nil {
		return err
	}
	return stream.setDeadline(time.Time{})
}
