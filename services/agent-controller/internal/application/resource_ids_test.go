package application

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type resourceIDVectors struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func readResourceIDVectors(t *testing.T) map[string]resourceIDVectors {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/common/id-vectors.json")
	require.NoError(t, err)
	var vectors map[string]resourceIDVectors
	require.NoError(t, json.Unmarshal(data, &vectors))
	return vectors
}

func TestResourceIDSharedVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	for _, kind := range []string{"organizationId", "userId", "agentId"} {
		for _, value := range vectors[kind].Accept {
			require.True(t, identifierPattern.MatchString(value), "%s must accept %q", kind, value)
		}
		for _, value := range vectors[kind].Reject {
			require.False(t, identifierPattern.MatchString(value), "%s must reject %q", kind, value)
		}
	}
}

func TestResourceIDPublishedSchemaVectors(t *testing.T) {
	vectors := readResourceIDVectors(t)
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	for _, path := range []string{
		"../../../../contracts/common/ids.schema.json",
		"../../../../contracts/agent-controller/control-api.ids-v2.schema.json",
	} {
		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		var meta struct {
			ID string `json:"$id"`
		}
		require.NoError(t, json.Unmarshal(raw, &meta))
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		require.NoError(t, err)
		require.NoError(t, compiler.AddResource(meta.ID, document))
	}
	const published = "https://schemas.antnest.dev/agent-controller/control-api.ids-v2.schema.json"
	cases := []struct {
		kind      string
		reference string
	}{
		{"agentId", published + "#/$defs/agent/properties/agent_id"},
		{"organizationId", published + "#/$defs/agent/properties/organization_id"},
		{"userId", published + "#/$defs/set_agent_authorization_request/properties/principal_id"},
	}
	for _, check := range cases {
		definition, err := compiler.Compile(check.reference)
		require.NoError(t, err, check.reference)
		for _, value := range vectors[check.kind].Accept {
			raw, err := json.Marshal(value)
			require.NoError(t, err)
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
			require.NoError(t, err)
			require.NoError(t, definition.Validate(instance), "%s must accept %q", check.kind, value)
		}
		for _, value := range vectors[check.kind].Reject {
			raw, err := json.Marshal(value)
			require.NoError(t, err)
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
			require.NoError(t, err)
			require.Error(t, definition.Validate(instance), "%s must reject %q", check.kind, value)
		}
	}
}

func TestResourceIDProducerGenerationPreserved(t *testing.T) {
	produced := domain.DeriveResourceID("agent", "agent", "request-create-agent")
	require.Equal(t, "agent_e94c17c429dc4904d167d643309872e5", produced)
	require.True(t, identifierPattern.MatchString(produced))
	vectors := readResourceIDVectors(t)
	found := false
	for _, value := range vectors["agentId"].Accept {
		found = found || value == produced
	}
	require.True(t, found, "deterministic producer output must remain in shared accepts")
}
