package rpc

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type RuntimeConnectionService interface {
	ResolveRuntimeConnection(context.Context, string, deployment.RuntimeRevision, string) (control.RuntimeConnection, error)
}

func (h *Handler) resolveRuntimeConnection(w http.ResponseWriter, r *http.Request) {
	var request struct {
		RuntimeRevision     deployment.RuntimeRevision `json:"runtime_revision"`
		ExpectedExecutionID string                     `json:"expected_execution_id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	raw, err := io.ReadAll(r.Body)
	if err != nil || serviceauth.DecodeObject(raw, &request) != nil || deployment.ValidateRevision(request.RuntimeRevision) != nil || request.ExpectedExecutionID == "" || len(request.ExpectedExecutionID) > 200 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Code: "invalid_request", Message: "Exact Runtime revision and execution identity are required", Retryable: false})
		return
	}
	resolver, ok := h.service.(RuntimeConnectionService)
	if !ok {
		writeConnectionError(w, control.ErrConnectionUnavailable)
		return
	}
	connection, err := resolver.ResolveRuntimeConnection(r.Context(), r.PathValue("agent_id"), request.RuntimeRevision, request.ExpectedExecutionID)
	if err != nil {
		writeConnectionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, connection)
}

func writeConnectionError(w http.ResponseWriter, err error) {
	status, code, message, retryable := http.StatusServiceUnavailable, "runtime_connection_unavailable", "Runtime connection verification is unavailable", true
	switch {
	case errors.Is(err, control.ErrNotFound):
		status, code, message, retryable = http.StatusNotFound, "runtime_not_found", "Runtime instance is absent", false
	case errors.Is(err, control.ErrConnectionStale):
		status, code, message, retryable = http.StatusConflict, "runtime_connection_stale", "Runtime connection binding is stale", false
	case errors.Is(err, control.ErrInvalidRequest):
		status, code, message, retryable = http.StatusBadRequest, "invalid_request", "Exact Runtime binding is required", false
	}
	writeJSON(w, status, errorResponse{Code: code, Message: message, Retryable: retryable})
}
