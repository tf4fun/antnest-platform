package postgres

import (
	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"testing"
)

func TestDisabledProviderIsPublishedUnavailableWithoutChangingModelPreference(t *testing.T) {
	repository := providerTestRepository(t)
	model := seedConfigurationProfile(t, repository, "retired", "org")
	before := currentExecutionSnapshot(t, repository, model.OrganizationID)
	require.True(t, publishedModel(t, before, model.ModelProfileID).Enabled)
	_, err := repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogProvider, model.ProviderConnectionID, model.OrganizationID, "retire-provider", true, false))
	require.NoError(t, err)
	after := currentExecutionSnapshot(t, repository, model.OrganizationID)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Len(t, after.Providers, 1)
	require.False(t, after.Providers[0].Enabled)
	require.NotNil(t, after.Providers[0].Credential, "internal publication retains the credential independently of availability")
	require.True(t, publishedModel(t, after, model.ModelProfileID).Enabled, "ACP combines Model and Provider availability")
	_, err = repository.GetCurrentModelProfileRevision(t.Context(), model.ModelProfileID)
	require.NoError(t, err, "disabled Provider does not erase a valid model reference")
	stored, err := repository.GetModelProfile(t.Context(), model.ModelProfileID)
	require.NoError(t, err)
	require.True(t, stored.Enabled, "Provider availability does not overwrite Model preference")
}

func TestCurrentModelPublicationDoesNotChangeBuildSnapshot(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	before := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	revised := integrationRevisedModelRecord(t, seed.Model)
	_, err := repository.ReviseModelProfile(t.Context(), 1, revised)
	require.NoError(t, err)
	after := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Equal(t, revised.Revision.Snapshot().Model.Parameters(), publishedModel(t, after, seed.Model.ModelProfileID).ModelParameters)
	require.Equal(t, before.Agents, after.Agents)
	unchanged, err := repository.GetAgentLifecycleBase(t.Context(), base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, base, unchanged)
}
