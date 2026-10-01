package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/stretchr/testify/require"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func reviseProfilePricing(t *testing.T, repository *Repository, current ports.ModelProfileRecord, input, output float64) ports.ModelProfileRecord {
	t.Helper()
	snapshot := current.Revision.Snapshot()
	expectedRevision := snapshot.Revision
	snapshot.ID += "-priced"
	snapshot.Revision++
	cacheRead, cacheWrite := 0.0, 3.0
	snapshot.Model.Pricing = &domain.ModelPricing{Currency: "USD", InputPerMillion: &input, OutputPerMillion: &output,
		CacheReadPerMillion: &cacheRead, CacheWritePerMillion: &cacheWrite}
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	current.Revision, current.RequestID = revision, current.RequestID+"-priced"
	fingerprint := sha256.Sum256([]byte(snapshot.ID))
	current.RequestFingerprint = hex.EncodeToString(fingerprint[:])
	current.UpdatedAt = current.UpdatedAt.Add(time.Second)
	result, err := repository.ReviseModelProfile(context.Background(), expectedRevision, current)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCurrentModelPricingPublicationSurvivesReopenWithoutChangingAgent(t *testing.T) {
	repository, base, seed := executionConfigurationRepository(t)
	before := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	priced := reviseProfilePricing(t, repository, seed.Model, 2, 8)
	after := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Equal(t, priced.Revision.Snapshot().Model.Pricing, publishedModel(t, after, seed.Model.ModelProfileID).Pricing)
	require.Equal(t, before.Agents, after.Agents)

	free := reviseProfilePricing(t, repository, priced, 0, 0)
	reopened, err := Open(t.Context(), repository.pool.Config().ConnString())
	require.NoError(t, err)
	defer reopened.Close()
	current := currentExecutionSnapshot(t, reopened, base.Agent.OrganizationID)
	require.Equal(t, after.Revision+1, current.Revision)
	pricing := publishedModel(t, current, seed.Model.ModelProfileID).Pricing
	require.Equal(t, free.Revision.Snapshot().Model.Pricing, pricing)
	require.NotNil(t, pricing.InputPerMillion)
	require.Zero(t, *pricing.InputPerMillion)
	require.NotNil(t, pricing.CacheReadPerMillion)
	require.Zero(t, *pricing.CacheReadPerMillion)
	require.Equal(t, float64(3), *pricing.CacheWritePerMillion)

	receipt, found, err := reopened.ReplayModelProfileRequest(t.Context(), ports.ReviseModelProfileRequest, priced.RequestID, priced.RequestFingerprint)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, priced.Revision.Snapshot().Model.Pricing, receipt.Revision.Snapshot().Model.Pricing)
	require.Equal(t, current, currentExecutionSnapshot(t, reopened, base.Agent.OrganizationID), "receipt replay cannot overwrite current pricing")
	unchanged, err := reopened.GetAgentLifecycleBase(t.Context(), base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, base, unchanged, "pricing does not rebuild Agent or Runtime")
}
