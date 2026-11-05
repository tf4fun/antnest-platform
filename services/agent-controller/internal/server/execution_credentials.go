package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type executionCredentialResolver interface {
	ResolveExecutionCredential(context.Context, ports.ExecutionCredentialRequest) (ports.ResolvedExecutionCredential, error)
}

func (h *handler) resolveExecutionCredential(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	var input ports.ExecutionCredentialRequest
	if !decodeJSON(response, request, &input) {
		return
	}
	resolver, ok := h.catalog.(executionCredentialResolver)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, apierror.DependencyUnavailable, "Execution credential resolution unavailable", true)
		return
	}
	resolved, err := resolver.ResolveExecutionCredential(request.Context(), input)
	if err != nil {
		switch {
		case errors.Is(err, application.ErrInvalidInput):
			writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "request is invalid", false)
		case errors.Is(err, ports.ErrNotFound):
			writeError(response, http.StatusNotFound, apierror.NotFound, "referenced resource was not found", false)
		case errors.Is(err, ports.ErrConcurrentChange):
			writeError(response, http.StatusConflict, apierror.ConfigurationConflict, "configuration changed concurrently", false)
		default:
			writeError(response, http.StatusServiceUnavailable, apierror.DependencyUnavailable, "dependency is unavailable", true)
		}
		return
	}
	writeJSON(response, http.StatusOK, resolved)
}
