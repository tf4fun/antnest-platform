package application

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func observationSet(t *testing.T) domain.ProviderObservationSet {
	t.Helper()
	canonical, err := domain.CanonicalProviderBaseURL("https://api.deepseek.com")
	require.NoError(t, err)
	contextTokens, maxOutput := int64(128000), int64(8192)
	tools := true
	return domain.ProviderObservationSet{
		Binding: domain.ProviderObservationBinding{OrganizationID: "org-1", ConnectionID: "provider-1", ProviderKey: "deepseek",
			RequestProtocol: "openai_chat_completions", BaseURL: canonical, CredentialRevision: "credential-current"},
		SourceRevision: 7,
		Models:         []domain.ProviderObservedModel{{Model: "current-model", ContextTokens: &contextTokens, MaxOutputTokens: &maxOutput, SupportsTools: &tools}},
	}
}

func TestExecutionProjectionPublishesMatchingObservations(t *testing.T) {
	source := executionSource(t)
	source.ProviderObservations = []domain.ProviderObservationSet{observationSet(t)}
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	model := value.Models[0]
	require.NotNil(t, model.ProviderTokenLimits)
	require.Equal(t, domain.ProviderTokenLimitsSource, model.ProviderTokenLimits.Source)
	require.Equal(t, int64(7), model.ProviderTokenLimits.SourceRevision)
	require.Equal(t, "current-model", model.ProviderTokenLimits.Binding.Model)
	require.Equal(t, int64(128000), *model.ProviderTokenLimits.ContextTokens)
	require.Equal(t, int64(8192), *model.ProviderTokenLimits.MaxOutputTokens)
	require.Equal(t, "credential-current", model.ProviderTokenLimits.Binding.CredentialRevision)
	require.NotNil(t, model.SupportsTools)
	require.True(t, *model.SupportsTools)
	// Cloned facts must not alias the source set.
	*model.ProviderTokenLimits.ContextTokens = 1
	*model.SupportsTools = false
	require.Equal(t, int64(128000), *source.ProviderObservations[0].Models[0].ContextTokens)
	require.True(t, *source.ProviderObservations[0].Models[0].SupportsTools)
}

func TestExecutionProjectionDropsMismatchedAndDisabledBindings(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		mutate func(set *domain.ProviderObservationSet, source *ports.ExecutionSource)
	}{
		{"wrong provider key", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.ProviderKey = "openrouter"
		}},
		{"wrong protocol", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.RequestProtocol = "other"
		}},
		{"wrong base URL", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.BaseURL = "https://other.example/"
		}},
		{"rotated credential", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.CredentialRevision = "credential-old"
		}},
		{"wrong organization", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.OrganizationID = "org-2"
		}},
		{"wrong connection", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.ConnectionID = "provider-2"
		}},
		{"wrong model id", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Models[0].Model = "other-model"
		}},
		{"disabled provider", func(_ *domain.ProviderObservationSet, source *ports.ExecutionSource) {
			source.Providers[0].Enabled = false
		}},
		{"invalid stored set", func(set *domain.ProviderObservationSet, _ *ports.ExecutionSource) {
			set.Binding.BaseURL = "https://api.deepseek.com:443"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source := executionSource(t)
			set := observationSet(t) // Each case needs its own Models slice.
			scenario.mutate(&set, &source)
			source.ProviderObservations = []domain.ProviderObservationSet{set}
			value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.Nil(t, value.Models[0].ProviderTokenLimits)
			require.Nil(t, value.Models[0].SupportsTools)
		})
	}
}

func TestExecutionProjectionCanonicalURLToolsOnlyAndExplicitFalse(t *testing.T) {
	source := executionSource(t)
	source.Providers[0].BaseURL = "HTTPS://API.DEEPSEEK.COM" // canonical equivalent
	set := observationSet(t)
	set.Models[0].ContextTokens, set.Models[0].MaxOutputTokens = nil, nil
	tools := false
	set.Models[0].SupportsTools = &tools
	source.ProviderObservations = []domain.ProviderObservationSet{set}
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	model := value.Models[0]
	require.Nil(t, model.ProviderTokenLimits, "tools-only observation must not invent token limits")
	require.NotNil(t, model.SupportsTools)
	require.False(t, *model.SupportsTools, "explicit false must be preserved")
	require.Equal(t, int(8192), model.ContextWindow, "editable values unchanged")
}

func TestExecutionProjectionEditedValuesCannotFillUnknownLimits(t *testing.T) {
	source := executionSource(t)
	set := observationSet(t)
	set.Models[0].ContextTokens, set.Models[0].MaxOutputTokens, set.Models[0].SupportsTools = nil, nil, nil
	source.ProviderObservations = []domain.ProviderObservationSet{set}
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	model := value.Models[0]
	require.Nil(t, model.ProviderTokenLimits)
	require.Nil(t, model.SupportsTools)
	require.Equal(t, 8192, model.ContextWindow, "editable context window is not a trusted bound")
}

func TestExecutionSnapshotRejectsMalformedObservations(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		mutate func(model *ports.ExecutionModel)
	}{
		{"wrong source", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Source = "edited" }},
		{"zero revision", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.SourceRevision = 0 }},
		{"overflow revision", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.SourceRevision = domain.MaximumSafeInteger + 1 }},
		{"wrong model", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Binding.Model = "other" }},
		{"wrong org", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Binding.OrganizationID = "org-2" }},
		{"wrong connection", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Binding.ConnectionID = "provider-2" }},
		{"wrong credential", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Binding.CredentialRevision = "old" }},
		{"zero dimension", func(m *ports.ExecutionModel) { zero := int64(0); m.ProviderTokenLimits.ContextTokens = &zero }},
		{"both dimensions unknown", func(m *ports.ExecutionModel) {
			m.ProviderTokenLimits.ContextTokens, m.ProviderTokenLimits.MaxOutputTokens = nil, nil
		}},
		{"noncanonical binding URL", func(m *ports.ExecutionModel) { m.ProviderTokenLimits.Binding.BaseURL = "https://api.deepseek.com:443" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			source := executionSource(t)
			source.ProviderObservations = []domain.ProviderObservationSet{observationSet(t)}
			snapshot, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
			require.NoError(t, err)
			require.NoError(t, snapshot.Validate(), "fresh fixture must validate before the case mutation")
			model := snapshot.Models[0]
			scenario.mutate(&model)
			snapshot.Models = []ports.ExecutionModel{model}
			require.ErrorIs(t, snapshot.Validate(), ports.ErrInvalidExecutionConfiguration)
		})
	}
}

func TestExecutionObservationFactsSerializeAndStayOutsideEditableParameters(t *testing.T) {
	source := executionSource(t)
	source.ProviderObservations = []domain.ProviderObservationSet{observationSet(t)}
	value, err := BuildExecutionSnapshot(t.Context(), source, &executionCredentialOpener{})
	require.NoError(t, err)
	payload, err := json.Marshal(value.Models[0])
	require.NoError(t, err)
	var wire map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(payload, &wire))
	require.Contains(t, string(wire["provider_token_limits"]), `"source":"models"`)
	require.Contains(t, string(wire["provider_token_limits"]), `"source_revision":7`)
	require.Contains(t, string(wire["supports_tools"]), `true`)
}
