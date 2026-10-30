package server

import (
	"encoding/json"
	"maps"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestModelProfileUsageForwardsVerifiedOrganizationScope(t *testing.T) {
	backend := newBackendStub()
	backend.enqueueFor("/internal/model-profiles/model-1/usage", http.StatusOK,
		`{"templates":2,"agents":3,"secret":"omitted","organization_id":"org-2"}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet,
		"/api/admin/model-profiles/model-1/usage", "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	call := backend.singleCall(t)
	require.Equal(t, upstream.AgentController, call.Target)
	require.Equal(t, http.MethodGet, call.Method)
	require.Equal(t, "/internal/model-profiles/model-1/usage", call.Path)
	require.Equal(t, "organization_id=org-1", call.Query)
	require.Empty(t, call.Body)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	require.JSONEq(t, `{"templates":2,"agents":3}`, response.Body.String())
}

func TestModelProfileUsageRejectsBrowserScopeAndRequestBody(t *testing.T) {
	for _, test := range []struct{ path, body string }{
		{"/api/admin/model-profiles/model-1/usage?organization_id=org-2", ""},
		{"/api/admin/model-profiles/model-1/usage?extra=1", ""},
		{"/api/admin/model-profiles/model-1/usage?organization_id=org-1&organization_id=org-1", ""},
		{"/api/admin/model-profiles/model-1/usage", `{"unexpected":true}`},
	} {
		backend := newBackendStub()
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet, test.path, test.body)
		require.Equal(t, http.StatusBadRequest, response.Code, test.path)
		require.Empty(t, backend.calls, test.path)
	}
}

func TestModelProfileUsageRejectsMalformedUpstreamCounts(t *testing.T) {
	for _, body := range []string{
		`{"templates":null,"agents":1}`,
		`{"templates":-1,"agents":0}`,
		`{"templates":1.5,"agents":0}`,
		`{"templates":"2","agents":0}`,
		`{"agents":0}`,
		`{"templates":0}`,
		`{"templates":9007199254740992,"agents":0}`,
	} {
		backend := newBackendStub()
		backend.enqueueFor("/internal/model-profiles/model-1/usage", http.StatusOK, body)
		response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet,
			"/api/admin/model-profiles/model-1/usage", "")
		require.Equal(t, http.StatusBadGateway, response.Code, body)
	}
	backend := newBackendStub()
	backend.enqueueFor("/internal/model-profiles/model-1/usage", http.StatusOK,
		`{"templates":0,"agents":0}`)
	response := requestAdmin(t, newTestHandler(t, backend), http.MethodGet,
		"/api/admin/model-profiles/model-1/usage", "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.JSONEq(t, `{"templates":0,"agents":0}`, response.Body.String())
}

func TestEffectiveModelsProjectLiveRevisionsAlongsideFrozenConfiguration(t *testing.T) {
	payload := []byte(`{"agent_id":"a1","lifecycle_state":"created","activation_state":"enabled",
		"runtime_state":"exited","configuration":{"model_profile":{"model_profile_id":"model-1",
		"revision":1,"revision_id":"rev-1","name":"Model","model":{"base_url":"https://model.example",
		"model":"support","context_window":8192,"max_output_tokens":1024,"supports_images":false}}},
		"effective_models":[{"model_profile_id":"model-1","revision":2},{"model_profile_id":"model-2","revision":5}]}`)
	result, err := projectAgent(payload)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(result, &got))
	models, ok := got["effective_models"].([]any)
	require.True(t, ok, "effective_models must survive the browser projection: %+v", got)
	require.Len(t, models, 2)
	require.Equal(t, map[string]any{"model_profile_id": "model-1", "revision": float64(2)}, models[0])
	require.Equal(t, map[string]any{"model_profile_id": "model-2", "revision": float64(5)}, models[1])
	configuration, ok := got["configuration"].(map[string]any)
	require.True(t, ok, "frozen configuration must stay untouched")
	profile, ok := configuration["model_profile"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, float64(1), profile["revision"])
}

func TestExecutionAuditProjectsAdmittedModelProfileRevision(t *testing.T) {
	original := replaceAuditField(t, []byte(auditDetailFixture()),
		"model_profile_revision", json.RawMessage(`7`))
	output, err := projectExecutionAuditDetail(original)
	require.NoError(t, err)
	var detail map[string]any
	require.NoError(t, json.Unmarshal(output, &detail))
	require.Equal(t, float64(7), detail["model_profile_revision"])

	output, err = projectExecutionAuditDetail([]byte(auditDetailFixture()))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(output, &detail))
	require.Contains(t, detail, "model_profile_revision")
	require.Nil(t, detail["model_profile_revision"])

	for _, invalid := range []string{`0`, `1.5`, `"7"`, `9007199254740992`} {
		_, err = projectExecutionAuditDetail(replaceAuditField(t,
			[]byte(auditDetailFixture()), "model_profile_revision", json.RawMessage(invalid)))
		require.Error(t, err, invalid)
	}
}

func TestExecutionAuditSnapshotPreservesCandidateRevisionsWithoutCredentials(t *testing.T) {
	snapshot := json.RawMessage(`{
		"organizationId":"org-1","modelProfileId":"model-1","modelProfileRevision":7,
		"providerConnectionId":"provider-1","configurationRevision":8,
		"agentSpecRevision":"spec-1","executionRevision":"execution-1","deadlineAt":"2026-09-14T12:00:00Z",
		"runtime":{"executionId":"execution-1","mcpEndpoint":"http://runtime/mcp"},
		"executionSpec":{"systemPrompt":"system","contextPolicyVersion":"context-v1","maxModelRequests":20,
			"skillInstructions":[],
			"model":{"baseUrl":"https://model.example","model":"example-model","contextWindow":128000,
				"maxOutputTokens":8192,"supportsImages":false,"credential":"hidden"},
			"fallbackModels":[{"modelProfileId":"model-2","providerConnectionId":"provider-2","modelProfileRevision":4,
				"model":{"baseUrl":"https://fallback.example","model":"fallback-model","contextWindow":64000,
					"maxOutputTokens":2048,"supportsImages":false,"credential":"hidden"}}],
			"compactionModel":{"modelProfileId":"model-3","providerConnectionId":"provider-3","modelProfileRevision":9,
				"model":{"baseUrl":"https://compactor.example","model":"summary-model","contextWindow":32000,
					"maxOutputTokens":1024,"supportsImages":false,"credential":"hidden"}},
			"configuration":{"modelProfileId":"model-1","authorizationRevision":2,"digest":"d","authorization":{"mode":"approve","toolRules":[]}}}}`)
	payload := replaceAuditField(t, []byte(auditDetailFixture()), "execution_snapshot", snapshot)
	output, err := projectExecutionAuditDetail(payload)
	require.NoError(t, err)
	var detail struct {
		ExecutionSnapshot struct {
			ModelProfileRevision float64 `json:"modelProfileRevision"`
			ExecutionSpec        struct {
				FallbackModels []struct {
					ModelProfileRevision float64 `json:"modelProfileRevision"`
				} `json:"fallbackModels"`
				CompactionModel struct {
					ModelProfileRevision float64 `json:"modelProfileRevision"`
				} `json:"compactionModel"`
			} `json:"executionSpec"`
		} `json:"execution_snapshot"`
	}
	require.NoError(t, json.Unmarshal(output, &detail))
	require.Equal(t, float64(7), detail.ExecutionSnapshot.ModelProfileRevision)
	require.Equal(t, float64(4), detail.ExecutionSnapshot.ExecutionSpec.FallbackModels[0].ModelProfileRevision)
	require.Equal(t, float64(9), detail.ExecutionSnapshot.ExecutionSpec.CompactionModel.ModelProfileRevision)
	require.NotContains(t, string(output), `"credential"`)
}

func TestExecutionAuditSnapshotRejectsInvalidCandidateRevisions(t *testing.T) {
	base := `{"modelProfileId":"model-1","modelProfileRevision":7,"executionSpec":{"model":{"model":"m"},
		"fallbackModels":[{"modelProfileId":"model-2","providerConnectionId":"p2","modelProfileRevision":4,"model":{"model":"f"}}],
		"compactionModel":{"modelProfileId":"model-3","providerConnectionId":"p3","modelProfileRevision":9,"model":{"model":"c"}},
		"configuration":{"modelProfileId":"model-1","authorization":{"mode":"approve","toolRules":[]}}}}`
	for _, mutate := range []struct{ name, needle, replacement string }{
		{"top zero", `"modelProfileRevision":7`, `"modelProfileRevision":0`},
		{"top unsafe", `"modelProfileRevision":7`, `"modelProfileRevision":9007199254740992`},
		{"top negative", `"modelProfileRevision":7`, `"modelProfileRevision":-1`},
		{"fallback zero", `"modelProfileRevision":4`, `"modelProfileRevision":0`},
		{"compactor fraction", `"modelProfileRevision":9`, `"modelProfileRevision":1.5`},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			broken := strings.Replace(base, mutate.needle, mutate.replacement, 1)
			require.NotEqual(t, base, broken)
			_, err := projectAuditExecutionSnapshot(json.RawMessage(broken))
			require.Error(t, err, mutate.name)
		})
	}
	legacy := strings.Replace(base, `,"modelProfileRevision":4`, ``, 1)
	_, err := projectAuditExecutionSnapshot(json.RawMessage(legacy))
	require.NoError(t, err)
}

func TestEffectiveModelsRejectsMalformedList(t *testing.T) {
	base := map[string]any{
		"agent_id": "a1", "lifecycle_state": "created", "activation_state": "enabled",
		"runtime_state": "exited", "created_at": "2026-09-13T00:00:00Z",
	}
	entry := func(id string, revision int64) map[string]any {
		return map[string]any{"model_profile_id": id, "revision": revision}
	}
	for _, test := range []struct {
		name    string
		models  any
		absent  bool
		wantErr bool
	}{
		{"valid", []any{entry("model-1", 2), entry("model-2", 5)}, false, false},
		{"explicit null", nil, false, true},
		{"empty array", []any{}, false, true},
		{"duplicate", []any{entry("model-1", 2), entry("model-1", 3)}, false, true},
		{"unsafe revision", []any{entry("model-1", 9007199254740992)}, false, true},
		{"zero revision", []any{entry("model-1", 0)}, false, true},
		{"empty id", []any{entry("", 2)}, false, true},
		{"overlong id", []any{entry(strings.Repeat("x", 201), 2)}, false, true},
		{"absent", nil, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			agent := maps.Clone(base)
			if !test.absent {
				agent["effective_models"] = test.models
			}
			payload, err := json.Marshal(agent)
			require.NoError(t, err)
			_, err = projectAgent(payload)
			if test.wantErr {
				require.Error(t, err, test.name)
			} else {
				require.NoError(t, err, test.name)
			}
		})
	}
}
