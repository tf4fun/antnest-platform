package postgres

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func availabilityChange(kind ports.CatalogResourceKind, id, org, request string, expected, enabled bool) ports.CatalogAvailabilityChange {
	return ports.CatalogAvailabilityChange{Kind: kind, ResourceID: id, OrganizationID: org, RequestID: request,
		Fingerprint: strings.Repeat("a", 64), ExpectedEnabled: expected, Enabled: enabled, Now: time.Now().UTC()}
}

func TestCatalogAvailabilityTemplateExitAndProviderRetirement(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	template := integrationTemplateRecord(t, model.Revision)
	_, err = repository.PutTemplate(t.Context(), template)
	require.NoError(t, err)
	before, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	provider := availabilityChange(ports.CatalogProvider, model.ProviderConnectionID, model.OrganizationID, "disable-provider", true, false)
	_, err = repository.SetCatalogAvailability(t.Context(), provider)
	var conflict *ports.CatalogReferenceConflict
	require.NoError(t, err, "referenced Provider can be disabled without changing Template")
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, model.ModelProfileID, model.OrganizationID, "disable-model", true, false))
	require.ErrorAs(t, err, &conflict)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, model.OrganizationID, "disable-template", true, false))
	require.NoError(t, err)
	afterTemplate, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, afterTemplate.Revision)
	history, err := repository.GetTemplateRevision(t.Context(), template.TemplateID, 1)
	require.NoError(t, err)
	require.Equal(t, template.Revision, history, "retirement does not remove access to historical configuration")
	result, err := repository.SetCatalogAvailability(t.Context(), provider)
	require.NoError(t, err, "disable is replayable without rewriting references")
	require.False(t, result.Enabled)
	current, err := repository.GetModelProfile(t.Context(), model.ModelProfileID)
	require.NoError(t, err)
	require.True(t, current.Enabled, "Provider disable does not rewrite Model preference")
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, template.TemplateID, model.OrganizationID, "enable-template", false, true))
	require.NoError(t, err, "template may retain temporarily disabled Provider")
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogProvider, provider.ResourceID, provider.OrganizationID, "enable-provider", false, true))
	require.NoError(t, err)
	replayed, err := repository.SetCatalogAvailability(t.Context(), provider)
	require.NoError(t, err)
	require.Equal(t, result, replayed)
	connection, err := repository.GetProviderConnection(t.Context(), provider.OrganizationID, provider.ResourceID)
	require.NoError(t, err)
	require.True(t, connection.Enabled, "replaying a disable must not undo a later enable")
	final, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+2, final.Revision)
}

func TestCatalogAvailabilityNoopAndRejectedChangesAreAtomic(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	before, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	input := availabilityChange(ports.CatalogModel, model.ModelProfileID, model.OrganizationID, "model-state", true, true)
	_, err = repository.SetCatalogAvailability(t.Context(), input)
	require.NoError(t, err)
	unchanged, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, unchanged)
	input.RequestID, input.Enabled = "model-blocked-capacity", false
	WithExecutionCapacityGuard(rejectedMutationGuard{})(repository)
	_, err = repository.SetCatalogAvailability(t.Context(), input)
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	current, err := repository.GetModelProfile(t.Context(), model.ModelProfileID)
	require.NoError(t, err)
	require.True(t, current.Enabled)
	WithExecutionCapacityGuard(nil)(repository)
	_, err = repository.SetCatalogAvailability(t.Context(), input)
	require.NoError(t, err)
	input.RequestID = "stale-state"
	_, err = repository.SetCatalogAvailability(t.Context(), input)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	input.RequestID, input.OrganizationID = "foreign", "foreign-org"
	_, err = repository.SetCatalogAvailability(t.Context(), input)
	require.ErrorIs(t, err, ports.ErrNotFound)
}

func TestCatalogAvailabilityCurrentAgentReferenceSurvivesTemplateDisable(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	spec := base.ConfiguredSpec.Snapshot
	_, err := repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogTemplate, spec.TemplateID, base.Agent.OrganizationID, "disable-template", true, false))
	require.NoError(t, err)
	_, err = repository.SetCatalogAvailability(t.Context(), availabilityChange(ports.CatalogModel, spec.ModelProfileID, base.Agent.OrganizationID, "disable-agent-model", true, false))
	var conflict *ports.CatalogReferenceConflict
	require.ErrorAs(t, err, &conflict)
	require.Contains(t, conflict.References, ports.CatalogReference{Kind: "agent", ResourceID: base.Agent.AgentID, AgentID: base.Agent.AgentID})
}
