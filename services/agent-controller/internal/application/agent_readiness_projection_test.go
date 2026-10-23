package application

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentReadinessQueryProjectionPreservesCurrentEvidenceAndLegacyUnknown(t *testing.T) {
	for _, operation := range []string{"get", "list"} {
		t.Run(operation, func(t *testing.T) {
			for _, scenario := range []struct {
				name   string
				want   string
				change func(*ports.AgentRecord)
			}{
				{name: "known_preparing", want: "preparing", change: func(agent *ports.AgentRecord) {
					agent.Readiness.AppliedRevision = 10
					agent.Readiness.Binding.AppliedRevision = 0
					agent.Readiness.Binding.ReadyAt = nil
				}},
				{name: "known_ready", want: "ready", change: func(*ports.AgentRecord) {}},
				{name: "known_unavailable", want: "unavailable", change: func(agent *ports.AgentRecord) {
					agent.ActiveOperationRequestID = "rebuild-in-progress"
				}},
				{name: "legacy_healthy_without_evidence", want: "", change: func(agent *ports.AgentRecord) {
					agent.Readiness = nil
				}},
			} {
				t.Run(scenario.name, func(t *testing.T) {
					store := agentReadinessQueryProjectionFixture()
					scenario.change(&store.record)
					store.records = []ports.AgentRecord{store.record}
					service := NewAgentQueryService(store)
					var view AgentView
					if operation == "get" {
						var err error
						view, err = service.GetAgentForOrganization(context.Background(), "org-1", "agent-1")
						require.NoError(t, err)
						require.Equal(t, "agent-1", store.configurationAgentID)
						require.Equal(t, "spec-3", store.configurationSpecID)
						require.NotNil(t, view.Configuration)
						require.Equal(t, "template-1", view.Configuration.TemplateID)
					} else {
						page, err := service.ListAgents(context.Background(), ListAgentsInput{OrganizationID: "org-1", Limit: 10})
						require.NoError(t, err)
						require.Len(t, page.Items, 1)
						require.Empty(t, page.NextCursor)
						require.Equal(t, "org-1", store.query.OrganizationID)
						view = page.Items[0]
					}
					require.Equal(t, scenario.want, view.Readiness)
					require.Equal(t, "agent-1", view.AgentID)
					require.Equal(t, "org-1", view.OrganizationID)
					require.Equal(t, "execution-4", view.ExecutionRevisionID)
					require.Equal(t, domain.RuntimeAvailable, view.RuntimeState, "health must remain independent from current readiness")
				})
			}
		})
	}
}

func agentReadinessQueryProjectionFixture() *agentQueryStoreStub {
	now := time.Date(2026, time.October, 23, 0, 0, 0, 0, time.UTC)
	agent := ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Research Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable,
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-3", ExecutionRevisionID: "execution-4",
		LastSuccessfulExecutionRevisionID: "execution-4", RuntimeRevision: "runtime-2",
		RuntimeExecutionID: "runtime-execution-2", RuntimeMCPEndpoint: "http://runtime/mcp",
		OwnerAuthorizationSequence: 5, IdentityRevocationSequence: 3,
		AggregateSequence: 9, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}
	agent.Readiness = &ports.AgentReadinessEvidence{
		Access: ports.AgentAccessRecord{AgentID: agent.AgentID, PrincipalID: agent.OwnerUserID,
			AccessRevision: agent.AccessRevision, Active: true, CreatedAt: now.Add(-time.Hour), UpdatedAt: now},
		OwnerRevocationSequence: 3, CommittedRevision: 12, AppliedRevision: 12,
		Binding: &ports.RuntimeReadinessProof{
			AgentID: agent.AgentID, OrganizationID: agent.OrganizationID,
			ExecutionRevisionID: agent.ExecutionRevisionID, AgentSpecRevisionID: agent.AgentSpecRevisionID,
			RuntimeRevision: agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID,
			OwnerUserID: agent.OwnerUserID, AccessRevision: agent.AccessRevision,
			OwnerAuthorizationSequence: agent.OwnerAuthorizationSequence,
			ReadyAfterRevision:         11, AppliedRevision: 12, ReadyAt: &now,
		},
	}
	return &agentQueryStoreStub{record: agent, configuration: ports.AgentConfigurationRecord{
		AgentID: agent.AgentID, AgentSpecRevisionID: agent.AgentSpecRevisionID,
		TemplateName: "Research", ModelProfileID: "model-1", ModelProfileRevision: 4, ModelProfileName: "Test model",
		Snapshot: domain.AgentSpecSnapshot{
			TemplateID: "template-1", TemplateRevision: 2, ModelProfileRevisionID: "model-revision-4",
			Model:            domain.ModelSpec{BaseURL: "https://model.test/v1", Model: "test-model", ContextWindow: 64000, MaxOutputTokens: 4096},
			MaxModelRequests: 24, ContextPolicyVersion: domain.ContextPolicyV1,
			Runtime: domain.RuntimeSpecInput{
				ImageRef:  "antnest/runtime@sha256:" + strings.Repeat("a", 64),
				Resources: domain.RuntimeResources{MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864},
			},
		},
	}}
}
