package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

type ModelCallPolicyService interface {
	Get(context.Context, string) (domain.ModelCallPolicy, error)
	Set(context.Context, application.SetModelCallPolicyInput) (domain.ModelCallPolicy, error)
}

func WithModelCallPolicyRoutes(base http.Handler, service ModelCallPolicyService, authentication ...Security) (http.Handler, error) {
	if base == nil || service == nil || len(authentication) != 1 || !authentication[0].valid() {
		return nil, fmt.Errorf("base handler, model call policy service and verified authentication are required")
	}
	security := authentication[0]
	mux := http.NewServeMux()
	h := &modelCallPolicyHandler{service: service}
	for _, route := range h.policyRoutes() {
		mux.Handle(route.pattern, security.guardRoute(route.pattern, telemetry.RPCHandler(route.pattern, route.handler)))
	}
	mux.Handle("/", base)
	return security.guardMux(mux), nil
}

type modelCallPolicyHandler struct {
	service ModelCallPolicyService
}

func (h *modelCallPolicyHandler) policyRoutes() []routeDefinition {
	return []routeDefinition{
		{pattern: "GET /internal/model-call-policy", handler: h.get},
		{pattern: "PUT /internal/model-call-policy", handler: h.set},
	}
}

func (h *modelCallPolicyHandler) get(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}})
	if !ok {
		return
	}
	if request.ContentLength != 0 || len(request.TransferEncoding) != 0 || !domain.ValidModelCallPolicyIdentifier(query.Get("organization_id")) {
		writeServiceError(request.Context(), response, application.ErrInvalidInput)
		return
	}
	policy, err := h.service.Get(request.Context(), query.Get("organization_id"))
	if err != nil {
		writeServiceError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, policy)
}

func (h *modelCallPolicyHandler) set(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if _, ok := strictQuery(response, request, map[string]struct{}{}); !ok {
		return
	}
	var input application.SetModelCallPolicyInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !input.Valid() {
		writeServiceError(request.Context(), response, application.ErrInvalidInput)
		return
	}
	policy, err := h.service.Set(request.Context(), input)
	if err != nil {
		if errors.Is(err, ports.ErrConcurrentChange) {
			writeError(response, http.StatusConflict, "resource_version_conflict", "Reload the model call policy before updating", false)
		} else {
			writeServiceError(request.Context(), response, err)
		}
		return
	}
	writeJSON(response, http.StatusOK, policy)
}
