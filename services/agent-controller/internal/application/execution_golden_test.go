package application

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var updateGolden = flag.Bool("update", false, "rewrite captured golden contract documents")

func writeGoldenDocument(t *testing.T, path string, body []byte) {
	t.Helper()
	var document any
	require.NoError(t, json.Unmarshal(body, &document))
	pretty, err := json.MarshalIndent(document, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, append(pretty, '\n'), 0o644))
}

func TestExecutionSnapshotGolden(t *testing.T) {
	const identifier = "https://schemas.antnest.dev/agent-acp/execution-snapshot.ids-v2.schema.json"
	contract, err := os.ReadFile("../../../../contracts/agent-acp/execution-snapshot.ids-v2.schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(contract))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	commonIDs, err := os.ReadFile("../../../../contracts/common/ids.schema.json")
	require.NoError(t, err)
	commonIDsDocument, err := jsonschema.UnmarshalJSON(bytes.NewReader(commonIDs))
	require.NoError(t, err)
	require.NoError(t, compiler.AddResource("https://schemas.antnest.dev/common/ids.schema.json", commonIDsDocument))
	require.NoError(t, compiler.AddResource(identifier, document))
	definition, err := compiler.Compile(identifier)
	require.NoError(t, err)
	for _, change := range []struct {
		name  string
		apply func(*ports.ExecutionSource)
	}{
		{name: "ready", apply: func(*ports.ExecutionSource) {}},
		{name: "preparing", apply: func(source *ports.ExecutionSource) {
			source.Agents[0].Agent.LifecycleState = domain.AgentNotCreated
			source.Agents[0].Agent.AgentSpecRevisionID = ""
			source.Agents[0].Agent.ExecutionRevisionID = ""
		}},
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
			golden := "../../../../contracts/agent-acp/examples/execution-snapshot." + change.name + ".json"
			if *updateGolden {
				writeGoldenDocument(t, golden, body)
			}
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
			require.NoError(t, err)
			require.NoError(t, definition.Validate(instance))
			expected, err := os.ReadFile(golden)
			require.NoError(t, err)
			require.JSONEq(t, string(expected), string(body))
			var wire map[string]any
			require.NoError(t, json.Unmarshal(body, &wire))
			require.Equal(t, float64(1), wire["schema_version"], "snapshot must declare schema_version 1")
		})
	}
}

func TestExecutionSnapshotV2Golden(t *testing.T) {
	const identifier = "https://schemas.antnest.dev/agent-acp/execution-publication-v2.ids-v2.schema.json"
	contract, err := os.ReadFile("../../../../contracts/agent-acp/execution-publication-v2.ids-v2.schema.json")
	require.NoError(t, err)
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(contract))
	require.NoError(t, err)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	commonIDs, err := os.ReadFile("../../../../contracts/common/ids.schema.json")
	require.NoError(t, err)
	commonIDsDocument, err := jsonschema.UnmarshalJSON(bytes.NewReader(commonIDs))
	require.NoError(t, err)
	require.NoError(t, compiler.AddResource("https://schemas.antnest.dev/common/ids.schema.json", commonIDsDocument))
	require.NoError(t, compiler.AddResource(identifier, document))
	legacy, err := os.ReadFile("../../../../contracts/agent-acp/execution-snapshot.ids-v2.schema.json")
	require.NoError(t, err)
	legacyDocument, err := jsonschema.UnmarshalJSON(bytes.NewReader(legacy))
	require.NoError(t, err)
	require.NoError(t, compiler.AddResource("https://schemas.antnest.dev/agent-acp/execution-snapshot.ids-v2.schema.json", legacyDocument))
	definition, err := compiler.Compile(identifier + "#/$defs/snapshot")
	require.NoError(t, err)
	source := executionSource(t)
	snapshot, err := BuildExecutionSnapshotV2(t.Context(), source)
	require.NoError(t, err)
	publisher := &ExecutionPublisher{runtime: fixtureExecutionRuntimeResolver()}
	require.NoError(t, publisher.resolveRuntimeAuthority(t.Context(), &snapshot))
	body, err := json.Marshal(snapshot)
	require.NoError(t, err)
	golden := "../../../../contracts/agent-acp/examples/execution-snapshot.v2.json"
	if *updateGolden {
		writeGoldenDocument(t, golden, body)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	require.NoError(t, err)
	require.NoError(t, definition.Validate(instance))
	expected, err := os.ReadFile(golden)
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(body))
	var wire map[string]any
	require.NoError(t, json.Unmarshal(body, &wire))
	require.Equal(t, float64(2), wire["schema_version"], "v2 publication keeps schema_version 2")
}
