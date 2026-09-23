package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func executionProvider(organization, id string) ports.ProviderConnectionRecord {
	return ports.ProviderConnectionRecord{RequestID: "create-" + id, RequestFingerprint: strings.Repeat("a", 64), ConnectionID: id, OrganizationID: organization,
		ProviderKey: "deepseek", DisplayName: "Provider", BaseURL: "https://api.deepseek.com", CredentialMethod: "api_key", CredentialVersion: "credential-1", CredentialRevision: 1,
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("synthetic-ciphertext"), Nonce: []byte("synthetic-nonce"), KeyVersion: "test"}, Enabled: true,
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC()}
}

func TestExecutionPublicationRevisionCommitsWithCatalogAndIgnoresReplay(t *testing.T) {
	repository := providerTestRepository(t)
	ctx := t.Context()
	provider := executionProvider("org1", "provider1")
	_, err := repository.PutProviderConnection(ctx, provider, nil)
	require.NoError(t, err)
	state, err := repository.GetExecutionSynchronization(ctx, "org1")
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	require.Zero(t, state.AppliedRevision)
	_, err = repository.PutProviderConnection(ctx, provider, nil)
	require.NoError(t, err)
	replayed, err := repository.GetExecutionSynchronization(ctx, "org1")
	require.NoError(t, err)
	require.Equal(t, state, replayed)

	provider.RequestID = "rotate-provider1"
	provider.CredentialVersion = "credential-2"
	provider.CredentialRevision = 2
	provider.SealedCredential.Ciphertext = []byte("synthetic-new-ciphertext")
	_, err = repository.RotateProviderCredential(ctx, "credential-1", provider)
	require.NoError(t, err)
	source, err := repository.ReadExecutionSource(ctx, "org1")
	require.NoError(t, err)
	require.EqualValues(t, 2, source.Revision)
	require.Len(t, source.Providers, 1)
	require.Equal(t, "credential-2", source.Providers[0].CredentialVersion)
	require.Equal(t, provider.SealedCredential, source.Providers[0].SealedCredential)
	_, err = repository.RotateProviderCredential(ctx, "credential-1", provider)
	require.NoError(t, err)
	source, err = repository.ReadExecutionSource(ctx, "org1")
	require.NoError(t, err)
	require.EqualValues(t, 2, source.Revision)
}

func TestExecutionPublicationRollbackDoesNotExposeResourceOrRevision(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	provider := executionProvider(model.OrganizationID, model.ProviderConnectionID)
	_, err := repository.PutProviderConnection(t.Context(), provider, []ports.ModelProfileRecord{model, model})
	require.Error(t, err)
	_, err = repository.GetProviderConnection(t.Context(), provider.OrganizationID, provider.ConnectionID)
	require.ErrorIs(t, err, ports.ErrNotFound)
	_, err = repository.ReadExecutionSource(t.Context(), provider.OrganizationID)
	require.ErrorIs(t, err, ports.ErrNotFound)
	organizations, err := repository.ListExecutionOrganizations(t.Context(), "", 10)
	require.NoError(t, err)
	require.Empty(t, organizations)
}

func TestExecutionPublicationModelWriteAdvancesCurrentConfiguration(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	first, err := repository.ReadExecutionSource(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.EqualValues(t, 2, first.Revision)
	require.Len(t, first.Models, 1)
	next := integrationRevisedModelRecord(t, model)
	_, err = repository.ReviseModelProfile(t.Context(), 1, next)
	require.NoError(t, err)
	current, err := repository.ReadExecutionSource(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.EqualValues(t, 3, current.Revision)
	require.Equal(t, next.Revision.Snapshot(), current.Models[0].Revision.Snapshot())
	_, err = repository.ReviseModelProfile(t.Context(), 1, next)
	require.NoError(t, err)
	state, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, current.Revision, state.Revision)
}

func TestExecutionPublicationIgnoresModelMetadataOnlyRevision(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	before, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	next := integrationRevisedModelRecord(t, model)
	next.DisplayName = model.DisplayName
	input := domain.ModelProfileRevisionInput(model.Revision.Snapshot())
	input.ID, input.Revision = next.Revision.ID(), next.Revision.Revision()
	next.Revision, err = domain.NewModelProfileRevision(input)
	require.NoError(t, err)
	_, err = repository.ReviseModelProfile(t.Context(), 1, next)
	require.NoError(t, err)
	after, err := repository.GetExecutionSynchronization(t.Context(), model.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	current, err := repository.GetModelProfile(t.Context(), model.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 2, current.Revision.Revision())
}

func TestExecutionPublicationReadsOwnedAgentAndInitialSpec(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	foreign := executionProvider("other-org", "foreign-provider")
	_, err := repository.PutProviderConnection(t.Context(), foreign, nil)
	require.NoError(t, err)
	ctx, parent := otel.Tracer("execution-source-test").Start(t.Context(), "publish Agent configuration")
	source, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	parent.End()
	require.NoError(t, err)
	assertExecutionSourceTrace(t, recorder.Ended(), parent.SpanContext())
	require.Len(t, source.Providers, 1)
	require.Len(t, source.Models, 1)
	require.Len(t, source.Agents, 1)
	agent := source.Agents[0]
	require.Equal(t, base.Agent.AgentID, agent.Agent.AgentID)
	require.Equal(t, base.Agent.AgentSpecRevisionID, agent.Spec.ID)
	require.Equal(t, base.Agent.AgentID, agent.Spec.AgentID)
	require.Equal(t, base.Agent.RuntimeMCPEndpoint, agent.Agent.RuntimeMCPEndpoint)
	require.Equal(t, domain.AuthorizationAuto, agent.Authorization.Mode)
	require.EqualValues(t, 1, agent.AuthorizationRevision)

	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents
SET lifecycle_state='not_created', activation_state='', executable_spec_revision_id='', executable_execution_revision_id='',
runtime_revision='', runtime_execution_id='', runtime_mcp_endpoint='', runtime_state='unknown'
WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	source, err = repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, base.Agent.AgentSpecRevisionID, source.Agents[0].Spec.ID)
	require.Empty(t, source.Agents[0].Agent.AgentSpecRevisionID)
	require.Equal(t, domain.AgentNotCreated, source.Agents[0].Agent.LifecycleState)
}

func TestExecutionPublicationDoesNotDropAnAgentWithMissingSpec(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	_, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET executable_spec_revision_id='missing-spec' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	source, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.Error(t, err)
	require.Empty(t, source)
}

func TestExecutionPublicationAcknowledgementsCannotCreateOrRegressDesiredState(t *testing.T) {
	repository := providerTestRepository(t)
	provider := executionProvider("org1", "provider1")
	_, err := repository.PutProviderConnection(t.Context(), provider, nil)
	require.NoError(t, err)
	first, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.NoError(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 1}))
	state, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.EqualValues(t, 1, state.AppliedRevision)
	require.Equal(t, first.UpdatedAt, state.UpdatedAt)
	require.NotNil(t, state.AppliedAt)
	require.Error(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 2}))
	require.Error(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "other-org", AppliedRevision: 1}))
	provider.RequestID, provider.CredentialVersion, provider.CredentialRevision = "rotate", "credential-2", 2
	_, err = repository.RotateProviderCredential(t.Context(), "credential-1", provider)
	require.NoError(t, err)
	require.NoError(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 2}))
	before, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.NoError(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 1}))
	after, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.Equal(t, before, after)
}

func TestExecutionPublicationSourceReadHonorsCancellation(t *testing.T) {
	repository := providerTestRepository(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	value, err := repository.ReadExecutionSource(ctx, "org1")
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, value)
}
