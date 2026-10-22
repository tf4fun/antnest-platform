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

type RuntimeBarrierRecoveryPolicyService interface {
	Get(context.Context, string) (domain.RuntimeBarrierRecoveryPolicy, error)
	Set(context.Context, application.SetRuntimeBarrierRecoveryPolicyInput) (domain.RuntimeBarrierRecoveryPolicy, error)
}

func WithRuntimeBarrierRecoveryPolicyRoutes(base http.Handler, service RuntimeBarrierRecoveryPolicyService, authentication ...Security) (http.Handler, error) {
	if base == nil || service == nil || len(authentication) != 1 || !authentication[0].valid() {
		return nil, fmt.Errorf("base handler, recovery policy service and verified authentication are required")
	}
	security := authentication[0]
	mux := http.NewServeMux()
	h := &runtimeBarrierRecoveryPolicyHandler{service: service}
	for _, route := range h.policyRoutes() {
		mux.Handle(route.pattern, security.guardRoute(route.pattern, telemetry.RPCHandler(route.pattern, route.handler)))
	}
	mux.Handle("/", base)
	return security.guardMux(mux), nil
}

type runtimeBarrierRecoveryPolicyHandler struct {
	service RuntimeBarrierRecoveryPolicyService
}

func (h *runtimeBarrierRecoveryPolicyHandler) policyRoutes() []routeDefinition {
	return []routeDefinition{
		{pattern: "GET /internal/runtime-barrier-recovery-policy", handler: h.get},
		{pattern: "PUT /internal/runtime-barrier-recovery-policy", handler: h.set},
	}
}

func (h *runtimeBarrierRecoveryPolicyHandler) get(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}})
	if !ok {
		return
	}
	if request.ContentLength != 0 || len(request.TransferEncoding) != 0 || !domain.ValidRuntimeBarrierPolicyIdentifier(query.Get("organization_id")) {
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

func (h *runtimeBarrierRecoveryPolicyHandler) set(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if _, ok := strictQuery(response, request, map[string]struct{}{}); !ok {
		return
	}
	var input application.SetRuntimeBarrierRecoveryPolicyInput
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
			writeError(response, http.StatusConflict, "resource_version_conflict", "Reload the Runtime barrier recovery policy before updating", false)
		} else {
			writeServiceError(request.Context(), response, err)
		}
		return
	}
	writeJSON(response, http.StatusOK, policy)
}
