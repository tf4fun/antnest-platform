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
