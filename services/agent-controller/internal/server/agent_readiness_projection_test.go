package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestAgentReadinessHTTPProjectionPreservesThreeStatesAndOmitsLegacyUnknown(t *testing.T) {
	for _, operation := range []string{"get", "list"} {
		t.Run(operation, func(t *testing.T) {
			for _, readiness := range []string{"preparing", "ready", "unavailable", ""} {
				name := readiness
				if name == "" {
					name = "legacy_healthy_without_readiness"
				}
				t.Run(name, func(t *testing.T) {
					now := time.Date(2026, time.October, 23, 0, 0, 0, 0, time.UTC)
					view := application.AgentView{
						Readiness: readiness,
						AgentID:   "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Research Agent",
						DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
						ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
						AccessRevision: "access-1", AgentSpecRevisionID: "spec-3", ExecutionRevisionID: "execution-4",
						LastSuccessfulExecutionRevisionID: "execution-4", RuntimeRevision: "runtime-2",
						RuntimeExecutionID: "runtime-execution-2", RuntimeMCPEndpoint: "http://runtime/mcp",
						AggregateSequence: 9, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
					}
					queries := &agentQueryServiceStub{agent: view, page: application.AgentPage{Items: []application.AgentView{view}}}
					handler, err := newBusinessHandler(t,
						&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
						&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil },
					)
					require.NoError(t, err)
					path := "/internal/agents/agent-1?organization_id=org-1"
					if operation == "list" {
						path = "/internal/agents?organization_id=org-1&limit=10"
					}
					response := httptest.NewRecorder()
					handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
					require.Equal(t, http.StatusOK, response.Code, response.Body.String())
					require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
					var payload map[string]json.RawMessage
					require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
					if operation == "list" {
						var items []map[string]json.RawMessage
						require.NoError(t, json.Unmarshal(payload["items"], &items))
						require.Len(t, items, 1)
						payload = items[0]
						require.Equal(t, "org-1", queries.listInput.OrganizationID)
						require.Equal(t, 1, queries.listCalls)
					} else {
						require.Equal(t, "agent-1", queries.agentID)
						require.Equal(t, "org-1", queries.organizationID)
					}
					if readiness == "" {
						require.NotContains(t, payload, "readiness", "legacy unknown must be omitted, even when Runtime is available")
					} else {
						require.Contains(t, payload, "readiness")
						var actual string
						require.NoError(t, json.Unmarshal(payload["readiness"], &actual))
						require.Equal(t, readiness, actual)
					}
					require.JSONEq(t, `"agent-1"`, string(payload["agent_id"]))
					require.JSONEq(t, `"available"`, string(payload["runtime_state"]), "readiness must not overwrite Runtime health")
				})
			}
		})
	}
}
