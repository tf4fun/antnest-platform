package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func liveModelProfileEventCount(t *testing.T, repository *Repository, modelID string) int {
	t.Helper()
	var count int
	require.NoError(t, repository.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_controller.model_profile_events WHERE model_profile_id=$1`, modelID).Scan(&count))
	return count
}

func TestLiveModelRevisionJournalWritesExactlyOnce(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	require.Zero(t, liveModelProfileEventCount(t, repository, model.ModelProfileID), "create must not emit a revision event")

	next := integrationRevisedModelRecord(t, model)
	stored, err := repository.ReviseModelProfile(t.Context(), 1, next)
	require.NoError(t, err)
	require.Equal(t, 1, liveModelProfileEventCount(t, repository, model.ModelProfileID))

	replayed, found, err := repository.ReplayModelProfileRequest(t.Context(), ports.ReviseModelProfileRequest, next.RequestID, next.RequestFingerprint)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, stored.Revision.ID(), replayed.Revision.ID())
	require.Equal(t, 1, liveModelProfileEventCount(t, repository, model.ModelProfileID), "receipt replay must not duplicate the event")

	stale := integrationRevisedModelRecord(t, stored)
	stale.RequestID, stale.RequestFingerprint = "request-stale", strings.Repeat("c", 64)
	_, err = repository.ReviseModelProfile(t.Context(), 9, stale)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.Equal(t, 1, liveModelProfileEventCount(t, repository, model.ModelProfileID), "rejected CAS must not emit an event")

	second := integrationRevisedModelRecord(t, stored)
	second.Revision = mustIntegrationModelRevision(t, "modelrev_integration_v3", 3)
	second.RequestID, second.RequestFingerprint = "request-second", strings.Repeat("d", 64)
	_, err = repository.ReviseModelProfile(t.Context(), 2, second)
	require.NoError(t, err)
	require.Equal(t, 2, liveModelProfileEventCount(t, repository, model.ModelProfileID))

	page, err := repository.ListModelProfileEvents(t.Context(), model.OrganizationID, model.ModelProfileID, 0, 1)
	require.NoError(t, err)
	require.Len(t, page, 2, "store returns the limit+1 probe row")
	require.EqualValues(t, 2, page[0].Revision)
	require.EqualValues(t, 1, page[0].PreviousRevision)
	require.Equal(t, next.Revision.ID(), page[0].RevisionID)
	require.Equal(t, next.RequestID, page[0].RequestID)
	require.Equal(t, ports.EventModelProfileRevised, page[0].EventType)
	require.False(t, page[0].OccurredAt.IsZero())

	rest, err := repository.ListModelProfileEvents(t.Context(), model.OrganizationID, model.ModelProfileID, 2, 50)
	require.NoError(t, err)
	require.Len(t, rest, 1)
	require.EqualValues(t, 3, rest[0].Revision)

	_, err = repository.ListModelProfileEvents(t.Context(), "other-org", model.ModelProfileID, 0, 50)
	require.ErrorIs(t, err, ports.ErrNotFound)
	_, err = repository.GetModelProfileUsage(t.Context(), "other-org", model.ModelProfileID)
	require.ErrorIs(t, err, ports.ErrNotFound)
}

func TestLiveModelIdenticalRevisionStillAdvancesPublication(t *testing.T) {
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
	require.Equal(t, before.Revision+1, after.Revision, "the profile revision is published metadata and must advance execution")
	published := publishedModel(t, currentExecutionSnapshot(t, repository, model.OrganizationID), model.ModelProfileID)
	require.EqualValues(t, 2, published.ModelProfileRevision)
	require.Equal(t, 1, liveModelProfileEventCount(t, repository, model.ModelProfileID))
}

func liveModelSeedTemplate(t *testing.T, repository *Repository, organization, key, primary string, fallbacks []string, enabled bool) {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-" + key, OrganizationID: organization, Revision: 1,
		ModelProfileID: primary, FallbackModelProfileIDs: fallbacks,
		SystemPrompt: "prompt", MaxModelRequests: 4, ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: domain.RuntimeSpecInput{
			ImageRef: "antnest/runtime@sha256:" + strings.Repeat("a", 64),
			Resources: domain.RuntimeResources{
				MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
			},
		},
	})
	require.NoError(t, err)
	now := time.Unix(1, 0).UTC()
	_, err = repository.PutTemplate(t.Context(), ports.TemplateRecord{
		RequestID: "request-template-" + key, RequestFingerprint: fmt.Sprintf("%064x", sha256.Sum256([]byte(key))),
		TemplateID: "template-" + key, OrganizationID: organization, TemplateKey: key,
		Name: key, Revision: revision, Enabled: enabled, CreatedAt: now, UpdatedAt: now,
	})
	require.NoError(t, err)
}

func TestLiveModelUsageCountsCurrentReferences(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	service := fixtureCatalogService(repository, box, providerTestClock{})
	ctx := context.Background()
	provider, err := service.CreateProviderConnection(ctx, providerTestInput("provider", "org-usage"))
	require.NoError(t, err)
	usedParameters := providerTestInput("unused", "org-usage").Models[0].Model
	usedParameters.Model = "used-api"
	created, err := service.CreateModelProfile(ctx, application.CreateModelProfileInput{
		RequestID: "create-profile", OrganizationID: "org-usage", ProviderConnectionID: provider.ConnectionID,
		ProfileKey: "used", DisplayName: "Used", Model: usedParameters,
	})
	require.NoError(t, err)
	otherParameters := usedParameters
	otherParameters.Model = "other-api"
	other, err := service.CreateModelProfile(ctx, application.CreateModelProfileInput{
		RequestID: "create-other", OrganizationID: "org-usage", ProviderConnectionID: provider.ConnectionID,
		ProfileKey: "other", DisplayName: "Other", Model: otherParameters,
	})
	require.NoError(t, err)

	usage, err := repository.GetModelProfileUsage(ctx, "org-usage", created.ModelProfileID)
	require.NoError(t, err)
	require.Equal(t, ports.ModelProfileUsage{}, usage)

	liveModelSeedTemplate(t, repository, "org-usage", "primary", created.ModelProfileID, nil, true)
	liveModelSeedTemplate(t, repository, "org-usage", "fallback", other.ModelProfileID, []string{created.ModelProfileID}, true)
	liveModelSeedTemplate(t, repository, "org-usage", "disabled", created.ModelProfileID, nil, false)
	usage, err = repository.GetModelProfileUsage(ctx, "org-usage", created.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 3, usage.Templates, "primary, fallback and disabled heads each count once")
	require.Zero(t, usage.Agents)

	revised, err := service.ReviseTemplate(ctx, application.ReviseTemplateInput{
		RequestID: "revise-template", OrganizationID: "org-usage", TemplateID: "template-primary",
		Name: "primary", ModelProfileID: other.ModelProfileID,
		SystemPrompt: "prompt", MaxModelRequests: 4, ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: domain.RuntimeSpecInput{ImageRef: "antnest/runtime@sha256:" + strings.Repeat("a", 64)},
	})
	require.NoError(t, err)
	require.NotNil(t, revised)
	usage, err = repository.GetModelProfileUsage(ctx, "org-usage", created.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 2, usage.Templates, "superseded Template revisions must not count")

	usage, err = repository.GetModelProfileUsage(ctx, "other-org", created.ModelProfileID)
	require.ErrorIs(t, err, ports.ErrNotFound)
	require.Equal(t, ports.ModelProfileUsage{}, usage)
}

func TestLiveModelUsageIncludesAgentsAndEffectiveModelsFollowHead(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	ctx := context.Background()

	usage, err := repository.GetModelProfileUsage(ctx, seed.Model.OrganizationID, seed.Model.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 1, usage.Templates)
	require.EqualValues(t, 1, usage.Agents)

	snapshot := seed.Model.Revision.Snapshot()
	snapshot.ID = "revision-live-v2"
	snapshot.Revision = 2
	next := seed.Model
	next.RequestID, next.RequestFingerprint = "request-live-v2", strings.Repeat("b", 64)
	next.Revision, err = domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	require.NoError(t, err)
	_, err = repository.ReviseModelProfile(ctx, 1, next)
	require.NoError(t, err)

	configuration, err := repository.GetAgentConfiguration(ctx, base.Agent.AgentID, base.Agent.AgentSpecRevisionID)
	require.NoError(t, err)
	require.EqualValues(t, 1, configuration.ModelProfileRevision, "frozen spec revision is unchanged")
	require.Equal(t, []ports.EffectiveModel{{ModelProfileID: seed.Model.ModelProfileID, Revision: 2}}, configuration.EffectiveModels,
		"effective models follow the live head")

	for _, nullFallback := range []string{"null", "[]"} {
		_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.agent_spec_revisions
 SET snapshot = jsonb_set(snapshot, '{fallback_model_profile_ids}', $2::jsonb) WHERE id=$1`,
			base.Agent.AgentSpecRevisionID, nullFallback)
		require.NoError(t, err)
		configuration, err = repository.GetAgentConfiguration(ctx, base.Agent.AgentID, base.Agent.AgentSpecRevisionID)
		require.NoError(t, err)
		require.Equal(t, []ports.EffectiveModel{{ModelProfileID: seed.Model.ModelProfileID, Revision: 2}}, configuration.EffectiveModels,
			"fallback JSON %s must still resolve effective models", nullFallback)
	}

	deleted, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET lifecycle_state='deleted' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted.RowsAffected())
	usage, err = repository.GetModelProfileUsage(ctx, seed.Model.OrganizationID, seed.Model.ModelProfileID)
	require.NoError(t, err)
	require.Zero(t, usage.Agents, "deleted Agents must not count")
}

func TestLiveModelUsageIncludesRunningLifecycleTargets(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	ctx := context.Background()

	other := seedConfigurationProfile(t, repository, "target", seed.Model.OrganizationID)
	usage, err := repository.GetModelProfileUsage(ctx, other.OrganizationID, other.ModelProfileID)
	require.NoError(t, err)
	require.Zero(t, usage.Agents)

	specSnapshot, err := json.Marshal(map[string]any{
		"model_profile_id": other.ModelProfileID, "template_id": "template-x", "template_revision": 1,
	})
	require.NoError(t, err)
	_, err = repository.pool.Exec(ctx, `INSERT INTO agent_controller.agent_spec_revisions
 (id, agent_id, revision, template_id, template_revision, model_profile_revision_id, canonical_digest, snapshot, created_at)
 VALUES ('spec-target-live', $1, 99, $2, 1, 'revision-x', $3, $4, NOW())`,
		base.Agent.AgentID, seed.Revision.Snapshot().TemplateID, strings.Repeat("f", 64), specSnapshot)
	require.NoError(t, err)
	_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET active_operation_request_id='op-live-target' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	_, err = repository.pool.Exec(ctx, `INSERT INTO agent_controller.agent_lifecycle_operations
 (request_id, request_fingerprint, agent_id, kind, phase, state,
  source_spec_revision_id, source_execution_revision_id, source_runtime_revision, target_spec_revision_id,
  recovery_after, created_at, updated_at)
 VALUES ('op-live-target', $2, $1, 'rebuild', 'publish', 'running',
  $3, $4, $5, 'spec-target-live', NOW(), NOW(), NOW())`,
		base.Agent.AgentID, strings.Repeat("e", 64),
		base.Agent.AgentSpecRevisionID, base.Agent.ExecutionRevisionID, base.Agent.RuntimeRevision)
	require.NoError(t, err)

	usage, err = repository.GetModelProfileUsage(ctx, other.OrganizationID, other.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 1, usage.Agents, "a running lifecycle target spec counts its Agent")

	_, err = repository.pool.Exec(ctx, `UPDATE agent_controller.agent_lifecycle_operations SET state='failed' WHERE request_id='op-live-target'`)
	require.NoError(t, err)
	usage, err = repository.GetModelProfileUsage(ctx, other.OrganizationID, other.ModelProfileID)
	require.NoError(t, err)
	require.Zero(t, usage.Agents, "completed lifecycle targets stop counting")
}

func TestLiveModelUsageNeverTruncates(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	_, err := repository.PutModelProfile(t.Context(), model)
	require.NoError(t, err)
	for index := 0; index < 105; index++ {
		key := fmt.Sprintf("bulk-%03d", index)
		liveModelSeedTemplate(t, repository, model.OrganizationID, key, model.ModelProfileID, nil, true)
	}
	usage, err := repository.GetModelProfileUsage(t.Context(), model.OrganizationID, model.ModelProfileID)
	require.NoError(t, err)
	require.EqualValues(t, 105, usage.Templates, "usage counts are complete, never capped like the disable reference list")
}
