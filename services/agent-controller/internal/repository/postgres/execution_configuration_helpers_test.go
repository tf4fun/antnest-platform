package postgres

import (
	"context"
	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"testing"
)

func executionConfigurationRepository(t *testing.T) (*Repository, ports.AgentLifecycleBase, rebuildSeed) {
	t.Helper()
	repository := providerTestRepository(t)
	base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
	return repository, base, seed
}

func seedConfigurationProfile(t *testing.T, repository *Repository, suffix, organization string) ports.ModelProfileRecord {
	t.Helper()
	record := integrationModelRecord(t)
	id := "profile-" + suffix
	snapshot := record.Revision.Snapshot()
	snapshot.ID, snapshot.ModelProfileID, snapshot.OrganizationID = "revision-"+suffix, id, organization
	record.ProviderConnectionID = "credential-" + suffix
	snapshot.Model.BaseURL, snapshot.Model.SupportsImages = "https://"+suffix+".test/v1", true
	snapshot.Model.ContextWindow = 2147483648
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	record.RequestID, record.ModelProfileID, record.OrganizationID, record.ProfileKey = "create-"+suffix, id, organization, suffix
	record.Revision = revision
	seedProviderForModel(t, repository, record)
	stored, err := repository.PutModelProfile(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}

func currentExecutionSnapshot(t *testing.T, repository *Repository, organizationID string) ports.ExecutionSnapshot {
	t.Helper()
	source, err := repository.ReadExecutionSource(t.Context(), organizationID)
	require.NoError(t, err)
	snapshot, err := application.BuildExecutionSnapshot(t.Context(), source, mutationCredentialOpener{})
	require.NoError(t, err)
	return snapshot
}

func publishedAgent(t *testing.T, repository *Repository, agent ports.AgentRecord) ports.ExecutionAgent {
	t.Helper()
	for _, item := range currentExecutionSnapshot(t, repository, agent.OrganizationID).Agents {
		if item.AgentID == agent.AgentID {
			return item
		}
	}
	t.Fatalf("Agent %s is absent from the execution configuration", agent.AgentID)
	return ports.ExecutionAgent{}
}

func publishedModel(t *testing.T, snapshot ports.ExecutionSnapshot, id string) ports.ExecutionModel {
	t.Helper()
	for _, item := range snapshot.Models {
		if item.ModelProfileID == id {
			return item
		}
	}
	t.Fatalf("Model %s is absent from the execution configuration", id)
	return ports.ExecutionModel{}
}

func assertExecutionClosed(t *testing.T, repository *Repository, agent ports.AgentRecord) {
	t.Helper()
	projection := publishedAgent(t, repository, agent)
	require.False(t, projection.AcceptingRuns)
	require.NotNil(t, projection.UnavailableReason)
}
