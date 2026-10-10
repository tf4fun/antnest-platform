package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

var (
	errWorkspaceSessionRejected     = errors.New("workspace session rejected")
	errWorkspaceIdentityUnavailable = errors.New("workspace identity unavailable")
)

func (h *handler) validStateRequest(response http.ResponseWriter, request *http.Request) bool {
	if request.Method != http.MethodGet {
		writeError(response, 405, "method_not_allowed", "Method is not allowed")
		return false
	}
	if request.URL.RawQuery != "" || len(request.Header.Values("Last-Event-ID")) != 0 {
		writeError(response, 400, "invalid_request", "Workspace state does not accept query fields or replay cursors")
		return false
	}
	if len(request.Header.Values("Origin")) > 0 && !h.sameOrigin(request) {
		writeError(response, 403, "forbidden", "Workspace origin is not allowed")
		return false
	}
	return true
}

func workspaceStateInput(request *http.Request, principal identity.Principal) agentacp.WorkspaceStateInput {
	return agentacp.WorkspaceStateInput{AgentID: request.PathValue("agent_id"), OrganizationID: principal.OrganizationID, PrincipalID: principal.UserID}
}

func (h *handler) getWorkspaceState(response http.ResponseWriter, request *http.Request) error {
	if !h.validStateRequest(response, request) {
		return nil
	}
	_, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	state, err := h.execution.GetWorkspaceState(ctx, workspaceStateInput(request, principal))
	if err != nil {
		workspaceStateError(response, err)
		return err
	}
	writeJSON(response, http.StatusOK, state)
	return nil
}

func (h *handler) watchWorkspaceState(response http.ResponseWriter, request *http.Request) error {
	if !h.validStateRequest(response, request) {
		return nil
	}
	select {
	case h.stateConnections <- struct{}{}:
		defer func() { <-h.stateConnections }()
	default:
		writeError(response, 503, "workspace_unavailable", "Workspace connection capacity is unavailable")
		return nil
	}
	values, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.streamLease)
	defer cancel()
	firstSnapshot := time.AfterFunc(h.requestTimeout, cancel)
	defer firstSnapshot.Stop()
	stream := workspaceStateStream{response: response, controller: http.NewResponseController(response)}
	err = h.execution.WatchWorkspaceState(ctx, workspaceStateInput(request, principal), func(state agentacp.WorkspaceState) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if stream.started {
			if err := h.validateStateIdentity(ctx, values.AccessToken, principal); err != nil {
				return err
			}
		} else {
			firstSnapshot.Stop()
		}
		return stream.emit(ctx, state)
	})
	if !stream.started {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		if request.Context().Err() == nil {
			workspaceStateError(response, err)
		}
		return err
	}
	// A finite stream lease and a disconnected client are normal closures.
	if request.Context().Err() != nil || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil
	}
	return err
}

func (h *handler) validateStateIdentity(ctx context.Context, token string, original identity.Principal) error {
	ctx, cancel := context.WithTimeout(ctx, h.requestTimeout)
	defer cancel()
	current, err := h.identity.Resolve(ctx, token)
	if err != nil && !identity.IsCode(err, "unauthenticated") && !identity.IsCode(err, "inactive_principal") {
		return errWorkspaceIdentityUnavailable
	}
	if err != nil || !current.Active || current.UserID == "" || current.OrganizationID == "" || current.MembershipID == "" ||
		current.UserID != original.UserID || current.OrganizationID != original.OrganizationID || current.MembershipID != original.MembershipID {
		return errWorkspaceSessionRejected
	}
	return nil
}

func workspaceStateError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agentacp.ErrInvalidWorkspaceScope):
		writeError(response, 400, "invalid_request", "Workspace scope is invalid")
	default:
		writeError(response, 503, "workspace_unavailable", "Workspace state is unavailable")
	}
}

type workspaceStateStream struct {
	response   http.ResponseWriter
	controller *http.ResponseController
	started    bool
}

func (stream *workspaceStateStream) emit(ctx context.Context, state agentacp.WorkspaceState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	if expires, ok := ctx.Deadline(); ok && expires.Before(deadline) {
		deadline = expires
	}
	if err := stream.controller.SetWriteDeadline(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
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
	err = stream.controller.SetWriteDeadline(time.Time{})
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}
