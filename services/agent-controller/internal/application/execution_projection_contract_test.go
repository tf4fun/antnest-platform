package application

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionProjectionConformsToSharedACPContract(t *testing.T) {
	body, err := os.ReadFile("../../../../contracts/agent-acp/execution-snapshot.schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	identifier := "https://antnest.local/contracts/agent-acp/execution-snapshot.schema.json"
	require.NoError(t, compiler.AddResource(identifier, document))
	definition, err := compiler.Compile(identifier)
	require.NoError(t, err)
	for _, change := range []struct {
		name  string
		apply func(*ports.ExecutionSource)
	}{
		{"ready", func(_ *ports.ExecutionSource) {}},
		{"initial build", func(s *ports.ExecutionSource) {
			s.Agents[0].Agent.LifecycleState = domain.AgentNotCreated
			s.Agents[0].Agent.AgentSpecRevisionID = ""
			s.Agents[0].Agent.ExecutionRevisionID = ""
		}},
		{"provider disabled", func(s *ports.ExecutionSource) { s.Providers[0].Enabled = false }},
		{"operation pending", func(s *ports.ExecutionSource) { s.Agents[0].Agent.ActiveOperationRequestID = "operation-1" }},
		{"identity revoked", func(s *ports.ExecutionSource) { s.Agents[0].Agent.IdentityRevocationSequence = 4 }},
	} {
		t.Run(change.name, func(t *testing.T) {
			source := executionSource(t)
			change.apply(&source)
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			publisher := &ExecutionPublisher{runtime: fixtureExecutionRuntimeResolver()}
			require.NoError(t, publisher.resolveRuntimeAuthority(t.Context(), &value))
			body, err := json.Marshal(value)
			require.NoError(t, err)
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
			require.NoError(t, err)
			require.NoError(t, definition.Validate(instance))
		})
	}
}

func TestExecutionModelPolicyDefaultsAndExplicitValuesConformToSharedACPContract(t *testing.T) {
	body, err := os.ReadFile("../../../../contracts/agent-acp/execution-snapshot.schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	identifier := "https://antnest.local/contracts/agent-acp/execution-snapshot.schema.json"
	require.NoError(t, compiler.AddResource(identifier, document))
	definition, err := compiler.Compile(identifier)
	require.NoError(t, err)
	for _, policy := range []struct {
		name     string
		stored   string
		expected string
	}{
		{
			name: "legacy effective defaults", stored: `{}`,
			expected: `{"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"before_output"}`,
		},
		{
			name: "explicit zero retry only", stored: `{"model_retry":{"max":0,"base_ms":1,"cap_ms":1}}`,
			expected: `{"model_retry":{"max":0,"base_ms":1,"cap_ms":1},"failover":"before_output"}`,
		},
		{
			name: "explicit never only", stored: `{"failover":"never"}`,
			expected: `{"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"never"}`,
		},
		{
			name: "explicit empty budget", stored: `{"run_budget":{}}`,
			expected: `{"model_retry":{"max":2,"base_ms":200,"cap_ms":30000},"failover":"before_output","run_budget":{}}`,
		},
		{
			name:     "explicit maximum and zero limits",
			stored:   `{"model_retry":{"max":8,"base_ms":30000,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":9007199254740991,"max_output_tokens":0,"max_cost_usd_micros":0}}`,
			expected: `{"model_retry":{"max":8,"base_ms":30000,"cap_ms":30000},"failover":"never","run_budget":{"max_input_tokens":9007199254740991,"max_output_tokens":0,"max_cost_usd_micros":0}}`,
		},
	} {
		t.Run(policy.name, func(t *testing.T) {
			source := executionSource(t)
			require.NoError(t, json.Unmarshal([]byte(policy.stored), &source.Agents[0].Spec.Snapshot))
			original, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.Len(t, value.Agents, 1)
			requireModelPolicyJSON(t, value.Agents[0], policy.expected)
			publisher := &ExecutionPublisher{runtime: fixtureExecutionRuntimeResolver()}
			require.NoError(t, publisher.resolveRuntimeAuthority(t.Context(), &value))
			payload, err := json.Marshal(value)
			require.NoError(t, err)
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
			require.NoError(t, err)
			require.NoError(t, definition.Validate(instance))
			after, err := json.Marshal(source.Agents[0].Spec.Snapshot)
			require.NoError(t, err)
			require.Equal(t, string(original), string(after), "wire defaults must not rewrite stored policy")
		})
	}
}
