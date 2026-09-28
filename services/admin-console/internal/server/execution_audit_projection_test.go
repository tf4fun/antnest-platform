package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func replaceAuditField(t *testing.T, payload []byte, name string, value json.RawMessage) []byte {
	t.Helper()
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(payload, &fields))
	if value == nil {
		delete(fields, name)
	} else {
		fields[name] = value
	}
	updated, err := json.Marshal(fields)
	require.NoError(t, err)
	return updated
}

func TestExecutionAuditProjectionDoesNotInventMissingFacts(t *testing.T) {
	for _, name := range []string{"terminal_class", "executor_state", "tool_effect_state", "stop_reason", "error_class"} {
		_, err := projectExecutionAuditDetail(replaceAuditField(t, []byte(auditDetailFixture()), name, nil))
		require.Error(t, err, name)
	}
	for _, visible := range []string{"", `,"visible":null`} {
		_, err := projectExecutionAuditEvents([]byte(`{"stream":"execution","items":[{"id":"event","sequence":1,"kind":"tool_result","payload":{},"created_at":"2026-09-14T10:00:00Z"` + visible + `}],"next_cursor":null}`))
		require.Error(t, err)
	}
	_, err := projectExecutionAuditEvents([]byte(`{"stream":"permissions","items":[{"tool_call_id":"call","request":{},"created_at":"2026-09-14T10:00:00Z"}],"next_cursor":null}`))
	require.Error(t, err)
	for _, state := range []string{
		`{"revision":8,"updated_at":"2026-09-14T10:00:00Z"}`,
		`{"revision":8,"applied_revision":null,"updated_at":"2026-09-14T10:00:00Z","applied_at":null}`,
		`{"revision":8,"applied_revision":0,"updated_at":"2026-09-14T10:00:00Z"}`,
	} {
		_, err := projectExecutionSynchronization("org-1")([]byte(`{"organization_id":"org-1","synchronization":` + state + `}`))
		require.Error(t, err, state)
	}
}

func TestExecutionAuditSnapshotProjectsPlatformFieldsWithoutRedactingContent(t *testing.T) {
	snapshot := json.RawMessage(`{
		"organizationId":"private-org","accessRevision":"private-access",
		"providerConnectionId":"provider-1","modelProfileId":"model-1","configurationRevision":8,
		"agentSpecRevision":"spec-1","executionRevision":"execution-1","deadlineAt":"2026-09-14T12:00:00Z",
		"runtime":{"executionId":"private-execution","mcpEndpoint":"http://private-runtime/mcp"},
		"executionSpec":{"systemPrompt":"system instructions","contextPolicyVersion":"context-v1","maxModelRequests":20,
			"skillInstructions":[{"skillKey":"report","version":"1","instructions":"skill content","internal_only":"private-skill"}],
			"model":{"baseUrl":"https://private-endpoint","model":"example-model","contextWindow":128000,"maxOutputTokens":8192,"supportsImages":false,
				"pricing":{"currency":"USD","inputPerMillion":0,"outputPerMillion":1,"internal_only":"private-pricing"},"internal_only":"private-model"},
			"configuration":{"modelProfileId":"model-1","authorizationRevision":2,"digest":"private-digest","authorization":{"mode":"approve","toolRules":[{"source":"runtime","sourceId":"builtin","toolName":"bash","decision":"allow","internal_only":"private-rule"}]}},
			"internal_only":"private-spec"},"internal_only":"private-top"}`)
	payload := replaceAuditField(t, []byte(auditDetailFixture()), "execution_snapshot", snapshot)
	payload = replaceAuditField(t, payload, "input", json.RawMessage(`[{"type":"text","text":"mcpEndpoint is user text, not a field to delete"}]`))
	output, err := projectExecutionAuditDetail(payload)
	require.NoError(t, err)
	var view map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(output, &view))
	require.NotContains(t, string(view["execution_snapshot"]), "private-")
	require.Contains(t, string(view["execution_snapshot"]), `"model":"example-model"`)
	require.Contains(t, string(view["execution_snapshot"]), `"inputPerMillion":0`)
	require.Contains(t, string(view["execution_snapshot"]), "system instructions")
	require.NotContains(t, string(view["execution_snapshot"]), "skill content")
	require.NotContains(t, string(view["execution_snapshot"]), "skillInstructions")
	require.Contains(t, string(view["execution_snapshot"]), `"decision":"allow"`)
	require.JSONEq(t, `[{"type":"text","text":"mcpEndpoint is user text, not a field to delete"}]`, string(view["input"]))
	output, err = projectExecutionAuditDetail(replaceAuditField(t, payload, "execution_snapshot", json.RawMessage(`null`)))
	require.NoError(t, err)
	require.Contains(t, string(output), `"execution_snapshot":null`)
}

func TestLifecycleProjectionDoesNotCarryExecutionAdmission(t *testing.T) {
	event := `{"event_id":"event-1","global_sequence":1,"aggregate_sequence":1,"schema_version":1,"agent_id":"agent-1","event_type":"agent_created","operation_request_id":"operation-1","admission_id":"old-execution-ticket","trace_id":"trace-1","occurred_at":"2026-09-14T10:00:00Z"}`
	for _, item := range []struct {
		project payloadProjector
		input   string
	}{
		{projectAgentEvent, event},
		{projectAgentEventList, `{"events":[` + event + `],"next_sequence":1}`},
	} {
		output, err := item.project([]byte(item.input))
		require.NoError(t, err)
		require.NotContains(t, string(output), "admission_id")
		require.Contains(t, string(output), "operation-1")
		require.Contains(t, string(output), "trace-1")
	}
}
