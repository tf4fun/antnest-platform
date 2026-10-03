package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type learningPolicyServiceStub struct {
	readOrg, readAgent, readPrincipal string
	write                             application.SetSkillLearningPolicyInput
	policy                            domain.SkillLearningPolicy
	err                               error
}

func (stub *learningPolicyServiceStub) Get(_ context.Context, org, agent, principal string) (domain.SkillLearningPolicy, error) {
	stub.readOrg, stub.readAgent, stub.readPrincipal = org, agent, principal
	return stub.policy, stub.err
}
func (stub *learningPolicyServiceStub) Set(_ context.Context, input application.SetSkillLearningPolicyInput) (domain.SkillLearningPolicy, error) {
	stub.write = input
	return stub.policy, stub.err
}

func TestSkillLearningPolicyRevisionConflictHasPolicyError(t *testing.T) {
	stub := &learningPolicyServiceStub{policy: domain.DefaultSkillLearningPolicy("org-1", "agent-1", "owner-1", time.Unix(1, 0)), err: ports.ErrConcurrentChange}
	boundary, err := withBusinessLearningRoutes(t, http.NotFoundHandler(), stub)
	require.NoError(t, err)
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/skill-learning-policy?organization_id=org-1&principal_id=owner-1", nil))
	require.Equal(t, http.StatusConflict, response.Code)
	require.Contains(t, response.Body.String(), `"code":"policy_revision_conflict"`)
}

func TestSkillLearningPolicyRoutesBindPathAndStrictScope(t *testing.T) {
	stub := &learningPolicyServiceStub{policy: domain.DefaultSkillLearningPolicy("org-1", "agent-1", "owner-1", time.Unix(1, 0))}
	boundary, err := withBusinessLearningRoutes(t, http.NotFoundHandler(), stub)
	require.NoError(t, err)
	read := httptest.NewRecorder()
	boundary.ServeHTTP(read, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/skill-learning-policy?organization_id=org-1&principal_id=owner-1", nil))
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	require.Equal(t, "org-1", stub.readOrg)
	require.Equal(t, "agent-1", stub.readAgent)
	require.Equal(t, "owner-1", stub.readPrincipal)
	require.Contains(t, read.Body.String(), `"mode":"automatic"`)
	require.Equal(t, "no-store", read.Header().Get("Cache-Control"))
	for _, query := range []string{"organization_id=org-1", "organization_id=org-1&principal_id=owner-1&extra=x", "organization_id=org-1&principal_id=owner-1&principal_id=other"} {
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1/skill-learning-policy?"+query, nil))
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	write := httptest.NewRecorder()
	boundary.ServeHTTP(write, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/skill-learning-policy",
		strings.NewReader(`{"request_id":"change-1","organization_id":"org-1","actor_principal_id":"owner-1","expected_revision":"`+stub.policy.Revision+`","mode":"off","scope":{"auto_generated_personal":true,"adopted_paths":[]},"pinned_paths":[],"limits":{"daily_reviews":20,"daily_model_input_tokens":320000,"daily_model_output_tokens":80000}}`)))
	require.Equal(t, http.StatusOK, write.Code, write.Body.String())
	require.Equal(t, "agent-1", stub.write.AgentID)
	require.Equal(t, "change-1", stub.write.RequestID)
	require.Equal(t, domain.LearningOff, stub.write.Mode)
	callerCut := httptest.NewRecorder()
	boundary.ServeHTTP(callerCut, httptest.NewRequest(http.MethodPut, "/internal/agents/agent-1/skill-learning-policy",
		strings.NewReader(`{"request_id":"change-2","organization_id":"org-1","actor_principal_id":"owner-1","expected_revision":"`+stub.policy.Revision+`","mode":"automatic","activation_cut_at":"2020-01-01T00:00:00Z","scope":{"auto_generated_personal":true,"adopted_paths":[]},"pinned_paths":[],"limits":{"daily_reviews":20,"daily_model_input_tokens":320000,"daily_model_output_tokens":80000}}`)))
	require.Equal(t, http.StatusBadRequest, callerCut.Code)
}
