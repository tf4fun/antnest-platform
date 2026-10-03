package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/authfixture"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/server"
)

// Catalog requests must not call lifecycle, execution or network services.
type unusedCatalogDependencies struct {
	server.LifecycleService
	server.AgentConfigurationService
	server.AgentQueryService
	server.AgentEventService
	server.NetworkPolicyService
}

func TestCatalogHTTPRetirementPreservesHistoryAndOrganizationFence(t *testing.T) {
	repository := providerTestRepository(t)
	base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
	catalog := application.NewCatalogService(repository, nil, providerTestClock{})
	unused := &unusedCatalogDependencies{}
	boundary, err := authfixture.NewHandler(t, catalog, unused, unused, unused, unused, unused, func(context.Context) error { return nil })
	require.NoError(t, err)
	path := "/internal/agent-templates/" + seed.Revision.Snapshot().TemplateID
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPut, path+"/availability", strings.NewReader(`{"request_id":"retire-template","organization_id":"org-integration","expected_enabled":true,"enabled":false}`)))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	response = httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path+"/revisions/1?organization_id=org-integration", nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var history struct {
		Enabled      bool
		Revision     int
		SystemPrompt string `json:"system_prompt"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &history))
	require.False(t, history.Enabled)
	require.Equal(t, 1, history.Revision)
	require.Equal(t, seed.Revision.Snapshot().SystemPrompt, history.SystemPrompt)
	response = httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path+"/revisions/1?organization_id=another-org", nil))
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	_, _, err = repository.BeginAgentCreate(t.Context(), identityCreate(base, "blocked-derivation", base.Agent.OrganizationID, 0))
	require.ErrorIs(t, err, ports.ErrDisabledReference)
	response = httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/internal/model-profiles/"+seed.Model.ModelProfileID+"/availability", strings.NewReader(`{"request_id":"retire-model","organization_id":"org-integration","expected_enabled":true,"enabled":false}`)))
	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	var conflict struct {
		Code       string
		References []ports.CatalogReference
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &conflict))
	require.Equal(t, "resource_in_use", conflict.Code)
	require.Equal(t, []ports.CatalogReference{{Kind: "agent", ResourceID: base.Agent.AgentID, AgentID: base.Agent.AgentID}}, conflict.References)
}
