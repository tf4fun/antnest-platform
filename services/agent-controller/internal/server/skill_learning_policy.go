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

type SkillLearningPolicyService interface {
	Get(context.Context, string, string, string) (domain.SkillLearningPolicy, error)
	Set(context.Context, application.SetSkillLearningPolicyInput) (domain.SkillLearningPolicy, error)
}

// The learning routes are composed separately so the existing Controller
// handler contracts remain stable while this service-owned batch is delivered.
func WithSkillLearningPolicyRoutes(base http.Handler, service SkillLearningPolicyService, authentication ...Security) (http.Handler, error) {
	if base == nil || service == nil || len(authentication) != 1 || !authentication[0].valid() {
		return nil, fmt.Errorf("base handler, policy service and verified authentication are required")
	}
	security := authentication[0]
	mux := http.NewServeMux()
	mux.Handle("GET /internal/agents/{agent_id}/skill-learning-policy", security.guardRoute("GET /internal/agents/{agent_id}/skill-learning-policy", telemetry.RPCHandler("GET /internal/agents/{agent_id}/skill-learning-policy", http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}, "principal_id": {}})
		if !ok {
			return
		}
		if query.Get("organization_id") == "" || query.Get("principal_id") == "" {
			writeError(response, http.StatusBadRequest, "invalid_request", "organization_id and principal_id are required", false)
			return
		}
		policy, err := service.Get(request.Context(), query.Get("organization_id"), request.PathValue("agent_id"), query.Get("principal_id"))
		if err != nil {
			writeSkillLearningPolicyError(request.Context(), response, err)
			return
		}
		writeJSON(response, http.StatusOK, policy)
	}))))
	mux.Handle("PUT /internal/agents/{agent_id}/skill-learning-policy", security.guardRoute("PUT /internal/agents/{agent_id}/skill-learning-policy", telemetry.RPCHandler("PUT /internal/agents/{agent_id}/skill-learning-policy", http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		if _, ok := strictQuery(response, request, map[string]struct{}{}); !ok {
			return
		}
		var input application.SetSkillLearningPolicyInput
		if !decodeJSON(response, request, &input) {
			return
		}
		input.AgentID = request.PathValue("agent_id")
		policy, err := service.Set(request.Context(), input)
		if err != nil {
			writeSkillLearningPolicyError(request.Context(), response, err)
			return
		}
		writeJSON(response, http.StatusOK, policy)
	}))))
	mux.Handle("/", base)
	return security.guardMux(mux), nil
}

func writeSkillLearningPolicyError(ctx context.Context, response http.ResponseWriter, err error) {
	if errors.Is(err, ports.ErrConcurrentChange) {
		writeError(response, http.StatusConflict, "policy_revision_conflict", "Reload the Skill learning policy before updating", false)
		return
	}
	writeServiceError(ctx, response, err)
}
