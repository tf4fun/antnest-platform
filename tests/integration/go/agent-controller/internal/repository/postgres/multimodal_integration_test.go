package postgres

import (
	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"testing"
	"time"
)

func TestModelCapabilitiesAreCurrentAndOrganizationScoped(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	other := seedConfigurationProfile(t, repository, "native", base.Agent.OrganizationID)
	foreign := seedConfigurationProfile(t, repository, "foreign-native", "foreign-organization")
	_, err := repository.ReviseModelProfile(t.Context(), 1, revisedNativeProfile(t, foreign, true))
	require.NoError(t, err)
	revised := revisedNativeProfile(t, other, true)
	_, err = repository.ReviseModelProfile(t.Context(), 1, revised)
	require.NoError(t, err)
	snapshot := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	require.Len(t, snapshot.Models, 2)
	current := publishedModel(t, snapshot, other.ModelProfileID)
	require.True(t, current.SupportsImages)
	require.True(t, current.SupportsAudio)
	require.True(t, current.SupportsPDF)
	require.False(t, publishedModel(t, snapshot, seed.Model.ModelProfileID).SupportsAudio)
	for _, model := range snapshot.Models {
		require.NotEqual(t, foreign.ModelProfileID, model.ModelProfileID)
	}
	for _, provider := range snapshot.Providers {
		require.NotEqual(t, foreign.ProviderConnectionID, provider.ConnectionID)
	}

	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, other.ModelProfileID, other.OrganizationID, "disable-native", true, false))
	require.NoError(t, err)
	disabled := publishedModel(t, currentExecutionSnapshot(t, repository, base.Agent.OrganizationID), other.ModelProfileID)
	require.False(t, disabled.Enabled)
	require.True(t, disabled.SupportsAudio, "availability must not erase capability metadata")
}

func TestCurrentNativeModelCapabilitiesPersistAcrossRevisionAndReopen(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	revised := revisedNativeProfile(t, seed.Model, true)
	stored, err := repository.ReviseModelProfile(t.Context(), 1, revised)
	require.NoError(t, err)
	before := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	require.Equal(t, revised.Revision.Snapshot().Model.Parameters(), publishedModel(t, before, seed.Model.ModelProfileID).ModelParameters)
	reopened, err := Open(t.Context(), repository.pool.Config().ConnString())
	require.NoError(t, err)
	defer reopened.Close()
	require.Equal(t, before, currentExecutionSnapshot(t, reopened, base.Agent.OrganizationID))
	next := revisedNativeProfile(t, stored, false)
	_, err = reopened.ReviseModelProfile(t.Context(), 2, next)
	require.NoError(t, err)
	after := currentExecutionSnapshot(t, reopened, base.Agent.OrganizationID)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Equal(t, next.Revision.Snapshot().Model.Parameters(), publishedModel(t, after, seed.Model.ModelProfileID).ModelParameters)
	require.Equal(t, before.Agents, after.Agents)
}

func revisedNativeProfile(t *testing.T, current ports.ModelProfileRecord, enabled bool) ports.ModelProfileRecord {
	t.Helper()
	snapshot := current.Revision.Snapshot()
	snapshot.ID += "-next"
	snapshot.Revision++
	snapshot.Model.SupportsImages, snapshot.Model.SupportsAudio, snapshot.Model.SupportsPDF = enabled, enabled, enabled
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	current.Revision, current.RequestID = revision, current.RequestID+"-next"
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	return current
}
