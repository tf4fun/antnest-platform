package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentQueryRepositoryFiltersDeletionAndKeysetOrder(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	first := time.Date(2026, time.September, 1, 10, 0, 0, 0, time.UTC)
	tied := first.Add(time.Second)
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentAvailable, first)
	insertQueryAgent(t, ctx, repository, "agent-b", "org-a", "user-a", domain.DesiredEnabled, domain.AgentAvailable, tied)
	insertQueryAgent(t, ctx, repository, "agent-c", "org-a", "user-a", domain.DesiredEnabled, domain.AgentAvailable, tied)
	insertQueryAgent(t, ctx, repository, "agent-other-owner", "org-a", "user-b", domain.DesiredDisabled, domain.AgentDisabled, tied.Add(time.Second))
	insertQueryAgent(t, ctx, repository, "agent-other-org", "org-b", "user-a", domain.DesiredEnabled, domain.AgentUnavailable, tied.Add(2*time.Second))
	insertQueryAgent(t, ctx, repository, "agent-deleted", "org-a", "user-a", domain.DesiredDeleted, domain.AgentDeleted, tied.Add(3*time.Second))

	page, err := repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-a", OwnerUserID: "user-a", Limit: 2,
	})
	if err != nil {
		t.Fatalf("list first page: %v", err)
	}
	assertAgentIDs(t, page, "agent-a", "agent-b")

	page, err = repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-a", OwnerUserID: "user-a",
		AfterCreatedAt: tied, AfterAgentID: "agent-b", Limit: 10,
	})
	if err != nil {
		t.Fatalf("continue list: %v", err)
	}
	assertAgentIDs(t, page, "agent-c")

	page, err = repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-a", OwnerUserID: "user-b", Limit: 10,
	})
	if err != nil {
		t.Fatalf("filter owner: %v", err)
	}
	assertAgentIDs(t, page, "agent-other-owner")

	page, err = repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-b", LifecycleState: domain.AgentUnavailable, Limit: 10,
	})
	if err != nil {
		t.Fatalf("filter organization and state: %v", err)
	}
	assertAgentIDs(t, page, "agent-other-org")

	page, err = repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-a", OwnerUserID: "user-a",
		LifecycleState: domain.AgentDeleted, Limit: 10,
	})
	if err != nil {
		t.Fatalf("keep deleted hidden: %v", err)
	}
	assertAgentIDs(t, page)

	page, err = repository.ListAgents(ctx, ports.AgentQuery{
		OrganizationID: "org-a", OwnerUserID: "user-a",
		LifecycleState: domain.AgentDeleted, IncludeDeleted: true, Limit: 10,
	})
	if err != nil {
		t.Fatalf("include deleted: %v", err)
	}
	assertAgentIDs(t, page, "agent-deleted")

	deleted, err := repository.GetAgent(ctx, "agent-deleted")
	if err != nil || deleted.DesiredState != domain.DesiredDeleted || deleted.AggregateSequence != 1 {
		t.Fatalf("get explicit deleted Agent: record=%+v err=%v", deleted, err)
	}
	_, err = repository.GetAgent(ctx, "agent-missing")
	if !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("missing Agent error = %v", err)
	}
}

func insertQueryAgent(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	organizationID string,
	ownerUserID string,
	desiredState domain.DesiredState,
	lifecycleState domain.AgentState,
	createdAt time.Time,
) {
	t.Helper()
	_, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.agents (
    id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
    access_revision, aggregate_sequence, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
		agentID, organizationID, ownerUserID, agentID, desiredState, lifecycleState,
		"access-"+agentID, createdAt,
	)
	if err != nil {
		t.Fatalf("insert Agent %s: %v", agentID, err)
	}
}

func assertAgentIDs(t *testing.T, records []ports.AgentRecord, expected ...string) {
	t.Helper()
	if len(records) != len(expected) {
		t.Fatalf("Agent count=%d expected=%d records=%+v", len(records), len(expected), records)
	}
	for index, id := range expected {
		if records[index].AgentID != id {
			t.Fatalf("Agent[%d]=%q expected=%q", index, records[index].AgentID, id)
		}
	}
}
