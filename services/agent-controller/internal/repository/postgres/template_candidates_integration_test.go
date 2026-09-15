package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestTemplateCandidatesPreserveOrderAndProtectAllReferences(t *testing.T) {
	repository := providerTestRepository(t)
	primary := seedConfigurationProfile(t, repository, "primary", "org")
	second := seedConfigurationProfile(t, repository, "second", "org")
	third := seedConfigurationProfile(t, repository, "third", "org")
	template := integrationTemplateRecord(t, primary.Revision)
	snapshot := template.Revision.Snapshot()
	template.OrganizationID, snapshot.OrganizationID = "org", "org"
	snapshot.FallbackModelProfileIDs = []string{third.ModelProfileID, second.ModelProfileID}
	var err error
	template.Revision, err = domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	require.NoError(t, err)
	_, err = repository.PutTemplate(t.Context(), template)
	require.NoError(t, err)
	loaded, err := repository.GetTemplate(t.Context(), template.TemplateID)
	require.NoError(t, err)
	require.Equal(t, snapshot.FallbackModelProfileIDs, loaded.Revision.Snapshot().FallbackModelProfileIDs)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogProvider, primary.ProviderConnectionID, "org", "disable-primary", true, false))
	require.NoError(t, err)
	loaded, err = repository.GetTemplate(t.Context(), template.TemplateID)
	require.NoError(t, err)
	require.Equal(t, snapshot, loaded.Revision.Snapshot())
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, third.ModelProfileID, "org", "disable-fallback-model", true, false))
	var conflict *ports.CatalogReferenceConflict
	require.ErrorAs(t, err, &conflict)
}

func TestTemplateCandidatesRejectForeignMissingAndRepeatedConnection(t *testing.T) {
	for _, name := range []string{"foreign", "missing", "same-connection"} {
		t.Run(name, func(t *testing.T) {
			repository := providerTestRepository(t)
			primary := seedConfigurationProfile(t, repository, "primary", "org")
			fallback := "missing-model"
			if name == "foreign" {
				fallback = seedConfigurationProfile(t, repository, "other", "another-org").ModelProfileID
			}
			if name == "same-connection" {
				other := integrationRevisedModelRecord(t, primary)
				other.ModelProfileID, other.ProfileKey, other.RequestID = "other-model", "other", "other-model"
				model := other.Revision.Snapshot()
				model.ID, model.ModelProfileID, model.Model.Model = "other-revision", other.ModelProfileID, "different-api-model"
				var err error
				other.Revision, err = domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(model))
				require.NoError(t, err)
				_, err = repository.PutModelProfile(t.Context(), other)
				require.NoError(t, err)
				fallback = other.ModelProfileID
			}
			template := integrationTemplateRecord(t, primary.Revision)
			snapshot := template.Revision.Snapshot()
			template.OrganizationID, snapshot.OrganizationID = "org", "org"
			snapshot.FallbackModelProfileIDs = []string{fallback}
			var err error
			template.Revision, err = domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
			require.NoError(t, err)
			_, err = repository.PutTemplate(t.Context(), template)
			require.Error(t, err)
			_, err = repository.GetTemplate(t.Context(), template.TemplateID)
			require.ErrorIs(t, err, ports.ErrNotFound)
		})
	}
}
