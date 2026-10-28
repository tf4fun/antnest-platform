package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestAgentModelPolicyHTTPPreservesFrozenConfigurationAndLegacyOmission(t *testing.T) {
	t.Parallel()
	compiler := compileControlSchema(t, repositoryRoot(t)+"/contracts/agent-controller/control-api.schema.json")
	for _, policy := range []struct {
		name string
		body string
	}{
		{"legacy omitted", `{}`},
		{"explicit zero retry never and zero caps", `{"model_retry":{"max":0,"base_ms":200,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":0,"max_output_tokens":9007199254740991,"max_cost_usd_micros":0}}`},
		{"explicit safe integer maximums", `{"model_retry":{"max":8,"base_ms":30000,"cap_ms":30000},"failover":"before_output","run_budget":{"max_input_tokens":9007199254740991,"max_output_tokens":0,"max_cost_usd_micros":9007199254740991}}`},
	} {
		t.Run(policy.name, func(t *testing.T) {
			now := time.Date(2026, time.September, 3, 12, 0, 0, 0, time.UTC)
			view := sampleControlAgent(now)
			view.Configuration = agentModelPolicyConfiguration()
			require.NoError(t, json.Unmarshal([]byte(policy.body), view.Configuration))
			original, err := json.Marshal(view)
			require.NoError(t, err)
			queries := &agentQueryServiceStub{agent: view}
			// The query service is a frozen-view stub. The GET route, verified
			// boundary, public mapper and shared response schema are real here.
			boundary, err := newBusinessHandler(t,
				&catalogServiceStub{}, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, queries,
				&agentEventServiceStub{}, &networkPolicyServiceStub{},
				func(context.Context) error { return nil },
			)
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1?organization_id=org-1", nil))
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			require.Equal(t, "agent-1", queries.agentID)
			require.Equal(t, "org-1", queries.organizationID)
			assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/agent", response.Body.Bytes())
			var decoded struct {
				Configuration map[string]json.RawMessage `json:"configuration"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &decoded))
			require.NotNil(t, decoded.Configuration)
			var expected map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(policy.body), &expected))
			for _, field := range []string{"model_retry", "failover", "run_budget"} {
				got, present := decoded.Configuration[field]
				want, wanted := expected[field]
				require.Equal(t, wanted, present, "configuration.%s presence", field)
				if wanted {
					require.JSONEq(t, string(want), string(got), "configuration.%s", field)
				}
			}
			afterRead, err := json.Marshal(queries.agent)
			require.NoError(t, err)
			require.Equal(t, string(original), string(afterRead), "GET must not materialize defaults or mutate the frozen view")

			// Bytes alone cannot prove mapper ownership. Mutate an actual mapped
			// response and check all optional pointers are detached from the view.
			mapped := agentPayload(queries.agent)
			require.NotNil(t, mapped.Configuration)
			if policy.name == "legacy omitted" {
				require.Nil(t, mapped.Configuration.ModelRetry)
				require.Empty(t, mapped.Configuration.Failover)
				require.Nil(t, mapped.Configuration.RunBudget)
			} else {
				stored := queries.agent.Configuration
				require.NotNil(t, mapped.Configuration.ModelRetry)
				require.NotNil(t, mapped.Configuration.RunBudget)
				require.NotSame(t, stored.ModelRetry, mapped.Configuration.ModelRetry)
				require.NotSame(t, stored.RunBudget, mapped.Configuration.RunBudget)
				require.NotSame(t, stored.RunBudget.MaxInputTokens, mapped.Configuration.RunBudget.MaxInputTokens)
				require.NotSame(t, stored.RunBudget.MaxOutputTokens, mapped.Configuration.RunBudget.MaxOutputTokens)
				require.NotSame(t, stored.RunBudget.MaxCostUSDMicros, mapped.Configuration.RunBudget.MaxCostUSDMicros)
				mapped.Configuration.ModelRetry.Max = 1
				mapped.Configuration.Failover = "never"
				*mapped.Configuration.RunBudget.MaxInputTokens = 1
				*mapped.Configuration.RunBudget.MaxOutputTokens = 1
				*mapped.Configuration.RunBudget.MaxCostUSDMicros = 1
				afterMutation, err := json.Marshal(queries.agent)
				require.NoError(t, err)
				require.Equal(t, string(original), string(afterMutation), "mapped policy mutated the original frozen view")
			}
			readAgain := httptest.NewRecorder()
			boundary.ServeHTTP(readAgain, httptest.NewRequest(http.MethodGet, "/internal/agents/agent-1?organization_id=org-1", nil))
			require.Equal(t, http.StatusOK, readAgain.Code, readAgain.Body.String())
			require.JSONEq(t, response.Body.String(), readAgain.Body.String())
			assertControlResponseSchema(t, compiler, "control-api.schema.json#/$defs/agent", readAgain.Body.Bytes())
		})
	}
}

func agentModelPolicyConfiguration() *application.AgentConfigurationView {
	return &application.AgentConfigurationView{
		TemplateID: "template-1", TemplateRevision: 2, TemplateName: "Research",
		ModelProfileID: "model-1", ModelProfileRevisionID: "model-revision-4",
		ModelProfileRevision: 4, ModelProfileName: "DeepSeek",
		Model: domain.ModelSpec{
			BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat",
			ContextWindow: 128000, MaxOutputTokens: 8192,
		},
		MaxModelRequests: 24, ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: domain.RuntimeSpecInput{
			ImageRef:  "antnest/runtime@sha256:" + strings.Repeat("a", 64),
			Resources: domain.RuntimeResources{MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864},
		},
	}
}
