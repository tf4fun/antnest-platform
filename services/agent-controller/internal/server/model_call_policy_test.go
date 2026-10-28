package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
)

type templatePolicyService struct {
	catalogServiceStub
	t      *testing.T
	inputs []map[string]json.RawMessage
}

func (s *templatePolicyService) policyView(input any) application.TemplateView {
	s.t.Helper()
	encoded, err := json.Marshal(input)
	require.NoError(s.t, err)
	var fields map[string]json.RawMessage
	require.NoError(s.t, json.Unmarshal(encoded, &fields))
	s.inputs = append(s.inputs, fields)
	view := sampleTemplateView()
	encoded, err = json.Marshal(view)
	require.NoError(s.t, err)
	var result map[string]json.RawMessage
	require.NoError(s.t, json.Unmarshal(encoded, &result))
	for _, key := range []string{"model_retry", "failover", "run_budget"} {
		if value, exists := fields[key]; exists {
			result[key] = value
		}
	}
	encoded, err = json.Marshal(result)
	require.NoError(s.t, err)
	require.NoError(s.t, json.Unmarshal(encoded, &view))
	s.templateView = view
	return view
}

func (s *templatePolicyService) CreateTemplate(_ context.Context, input application.CreateTemplateInput) (application.TemplateView, error) {
	return s.policyView(input), nil
}

func (s *templatePolicyService) ReviseTemplate(_ context.Context, input application.ReviseTemplateInput) (application.TemplateView, error) {
	return s.policyView(input), nil
}

func templatePolicyRequest(fields string) string {
	return `{"request_id":"policy-request","organization_id":"org-1","name":"policy","model_profile_id":"model-1","system_prompt":"hello","max_model_requests":8,"context_policy_version":"context-v1","runtime":{"image_ref":"alpine:3.23","resources":{"memory_bytes":134217728,"pids_limit":16,"tmpfs_bytes":16777216}},` + fields + `}`
}

func TestTemplateModelPolicyHTTPRoundTrip(t *testing.T) {
	policy := `"model_retry":{"max":0,"base_ms":200,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":0,"max_output_tokens":9007199254740991,"max_cost_usd_micros":0}`
	for _, operation := range []struct {
		name, path, extra string
		status            int
	}{
		{"create", "/internal/agent-templates", `"template_key":"policy",`, http.StatusCreated},
		{"revise", "/internal/agent-templates/template-1/revisions", "", http.StatusCreated},
	} {
		t.Run(operation.name, func(t *testing.T) {
			service := &templatePolicyService{t: t}
			boundary, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost, operation.path, strings.NewReader(templatePolicyRequest(operation.extra+policy))))
			require.Equal(t, operation.status, response.Code, response.Body.String())
			require.Len(t, service.inputs, 1)
			for _, key := range []string{"model_retry", "failover", "run_budget"} {
				var expected map[string]json.RawMessage
				require.NoError(t, json.Unmarshal([]byte("{"+policy+"}"), &expected))
				require.JSONEq(t, string(expected[key]), string(service.inputs[0][key]))
			}
			for _, path := range []string{"/internal/agent-templates/template-1?organization_id=org-1", "/internal/agent-templates/template-1/revisions/1?organization_id=org-1"} {
				read := httptest.NewRecorder()
				boundary.ServeHTTP(read, httptest.NewRequest(http.MethodGet, path, nil))
				require.Equal(t, http.StatusOK, read.Code, read.Body.String())
				var result map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(read.Body.Bytes(), &result))
				for _, key := range []string{"model_retry", "failover", "run_budget"} {
					require.JSONEq(t, string(service.inputs[0][key]), string(result[key]))
				}
			}
		})
	}
}

func TestTemplateModelPolicyHTTPRejectsMalformedBeforeCatalog(t *testing.T) {
	for _, invalid := range []string{
		`"model_retry":null`, `"model_retry":{}`, `"model_retry":{"base_ms":1,"cap_ms":2}`,
		`"model_retry":{"max":null,"base_ms":1,"cap_ms":2}`,
		`"model_retry":{"max":9,"base_ms":1,"cap_ms":2}`,
		`"model_retry":{"max":1,"base_ms":3,"cap_ms":2}`,
		`"model_retry":{"max":0,"base_ms":1,"cap_ms":2,"extra":true}`,
		`"Model_Retry":{"max":0,"base_ms":1,"cap_ms":2}`,
		`"failover":null`, `"failover":""`, `"failover":"always"`,
		`"run_budget":null`, `"run_budget":{"max_input_tokens":null}`,
		`"run_budget":{"max_input_tokens":-1}`, `"run_budget":{"max_input_tokens":0.5}`,
		`"run_budget":{"max_cost_usd_micros":9007199254740992}`,
		`"run_budget":{"max_output_tokens":1,"extra":true}`,
	} {
		t.Run(invalid, func(t *testing.T) {
			service := &templatePolicyService{t: t}
			boundary, err := newBusinessHandler(t, service, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
			require.NoError(t, err)
			response := httptest.NewRecorder()
			boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/agent-templates", strings.NewReader(templatePolicyRequest(`"template_key":"policy",`+invalid))))
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Empty(t, service.inputs)
		})
	}
}

func TestTemplateModelPolicyControlSchemaMatchesCanonical(t *testing.T) {
	var canonical, control struct {
		Definitions map[string]json.RawMessage `json:"$defs"`
	}
	readContractJSON(t, repositoryRoot(t)+"/contracts/agent-controller/model-call-policy.schema.json", &canonical)
	readContractJSON(t, repositoryRoot(t)+"/contracts/agent-controller/control-api.schema.json", &control)
	for _, name := range []string{"model_retry", "run_budget"} {
		require.JSONEq(t, string(canonical.Definitions[name]), string(control.Definitions[name]), name)
	}
	var policy struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	require.NoError(t, json.Unmarshal(canonical.Definitions["template_policy"], &policy))
	for _, name := range []string{"create_template_request", "revise_template_request", "agent_template", "agent_configuration"} {
		var message struct {
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		require.NoError(t, json.Unmarshal(control.Definitions[name], &message))
		for _, field := range []string{"model_retry", "failover", "run_budget"} {
			require.JSONEq(t, string(policy.Properties[field]), string(message.Properties[field]), name+"."+field)
			require.NotContains(t, message.Required, field, "legacy messages retain omitted fields")
		}
	}
}
