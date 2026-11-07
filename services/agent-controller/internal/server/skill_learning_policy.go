package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/apierror"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// The learning routes are registered by the main Controller handler so the
// handler contracts cover the complete service-owned boundary.
type SkillLearningPolicyService interface {
	Get(context.Context, string, string, string) (domain.SkillLearningPolicy, error)
	Set(context.Context, application.SetSkillLearningPolicyInput) (domain.SkillLearningPolicy, error)
}

func (h *handler) getSkillLearningPolicy(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	query, ok := strictQuery(response, request, map[string]struct{}{"organization_id": {}, "principal_id": {}})
	if !ok {
		return
	}
	if query.Get("organization_id") == "" || query.Get("principal_id") == "" {
		writeError(response, http.StatusBadRequest, apierror.InvalidRequest, "organization_id and principal_id are required", false)
		return
	}
	policy, err := h.learning.Get(request.Context(), query.Get("organization_id"), request.PathValue("agent_id"), query.Get("principal_id"))
	if err != nil {
		writeSkillLearningPolicyError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, policy)
}

func (h *handler) setSkillLearningPolicy(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if _, ok := strictQuery(response, request, map[string]struct{}{}); !ok {
		return
	}
	var input application.SetSkillLearningPolicyInput
	if !decodeJSON(response, request, &input) {
		return
	}
	input.AgentID = request.PathValue("agent_id")
	policy, err := h.learning.Set(request.Context(), input)
	if err != nil {
		writeSkillLearningPolicyError(request.Context(), response, err)
		return
	}
	writeJSON(response, http.StatusOK, policy)
}

func writeSkillLearningPolicyError(ctx context.Context, response http.ResponseWriter, err error) {
	if errors.Is(err, ports.ErrConcurrentChange) {
		writeError(response, http.StatusConflict, apierror.PolicyRevisionConflict, "Reload the Skill learning policy before updating", false)
		return
	}
	writeServiceError(ctx, response, err)
}
