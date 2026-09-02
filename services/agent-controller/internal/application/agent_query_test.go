package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestGetAgentReturnsCurrentProjection(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	store := &agentQueryStoreStub{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Research Agent", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentAvailable, AccessRevision: "access-1",
		AgentSpecRevisionID: "spec-3", ExecutionRevisionID: "execution-4",
		LastSuccessfulExecutionRevisionID: "execution-4", RuntimeRevision: "runtime-2",
		RuntimeExecutionID: "runtime-execution-2", RuntimeMCPEndpoint: "http://runtime/mcp",
		AggregateSequence: 9, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}}
	service := NewAgentQueryService(store)

	view, err := service.GetAgent(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("get Agent: %v", err)
	}
	if store.getAgentID != "agent-1" {
		t.Fatalf("queried Agent = %q", store.getAgentID)
	}
	if view.OwnerUserID != "user-1" || view.AggregateSequence != 9 ||
		view.ExecutionRevisionID != "execution-4" || view.RuntimeRevision != "runtime-2" {
		t.Fatalf("current projection was not preserved: %+v", view)
	}
}

func TestGetAgentMapsMissingProjectionAndRejectsInvalidIdentity(t *testing.T) {
	t.Parallel()

	store := &agentQueryStoreStub{err: ports.ErrNotFound}
	service := NewAgentQueryService(store)
	_, err := service.GetAgent(context.Background(), "agent-missing")
	if !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("missing Agent error = %v", err)
	}

	store.calls = 0
	_, err = service.GetAgent(context.Background(), "not valid")
	if !errors.Is(err, ErrInvalidInput) || store.calls != 0 {
		t.Fatalf("invalid identity error=%v calls=%d", err, store.calls)
	}
}

func TestGetAgentForOrganizationMasksCrossOrganizationProjection(t *testing.T) {
	t.Parallel()

	store := &agentQueryStoreStub{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Agent", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentAvailable, AccessRevision: "access-1",
		AggregateSequence: 1, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}}
	service := NewAgentQueryService(store)

	_, err := service.GetAgentForOrganization(context.Background(), "org-2", "agent-1")
	if !errors.Is(err, ErrAgentNotFound) || store.calls != 1 {
		t.Fatalf("cross-organization Agent error=%v calls=%d", err, store.calls)
	}
	store.calls = 0
	_, err = service.GetAgentForOrganization(context.Background(), "not valid", "agent-1")
	if !errors.Is(err, ErrInvalidInput) || store.calls != 0 {
		t.Fatalf("invalid scope error=%v calls=%d", err, store.calls)
	}
}

func TestListAgentsUsesStableOpaqueKeysetCursor(t *testing.T) {
	t.Parallel()

	firstTime := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	secondTime := firstTime.Add(time.Second)
	store := &agentQueryStoreStub{records: []ports.AgentRecord{
		queryAgentRecord("agent-1", "user-1", domain.AgentAvailable, firstTime),
		queryAgentRecord("agent-2", "user-1", domain.AgentAvailable, secondTime),
		queryAgentRecord("agent-3", "user-1", domain.AgentAvailable, secondTime),
	}}
	service := NewAgentQueryService(store)

	page, err := service.ListAgents(context.Background(), ListAgentsInput{
		OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentAvailable, Limit: 2,
	})
	if err != nil {
		t.Fatalf("list Agents: %v", err)
	}
	if len(page.Items) != 2 || page.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v", page)
	}
	if store.query.Limit != 3 || store.query.IncludeDeleted ||
		store.query.OrganizationID != "org-1" || store.query.OwnerUserID != "user-1" ||
		store.query.LifecycleState != domain.AgentAvailable {
		t.Fatalf("query filters were not preserved: %+v", store.query)
	}

	store.records = nil
	_, err = service.ListAgents(context.Background(), ListAgentsInput{
		OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentAvailable, Limit: 2, Cursor: page.NextCursor,
	})
	if err != nil {
		t.Fatalf("continue Agent list: %v", err)
	}
	if !store.query.AfterCreatedAt.Equal(secondTime) || store.query.AfterAgentID != "agent-2" {
		t.Fatalf("cursor did not restore keyset coordinates: %+v", store.query)
	}
}

func TestListAgentsDefaultsAndDeletionVisibilityAreExplicit(t *testing.T) {
	t.Parallel()

	store := &agentQueryStoreStub{}
	service := NewAgentQueryService(store)
	page, err := service.ListAgents(context.Background(), ListAgentsInput{
		LifecycleState: domain.AgentDeleted,
	})
	if err != nil {
		t.Fatalf("list default hidden deleted Agents: %v", err)
	}
	if len(page.Items) != 0 || page.NextCursor != "" || store.calls != 0 {
		t.Fatalf("contradictory deletion filter reached storage: page=%+v calls=%d", page, store.calls)
	}

	_, err = service.ListAgents(context.Background(), ListAgentsInput{
		LifecycleState: domain.AgentDeleted, IncludeDeleted: true,
	})
	if err != nil {
		t.Fatalf("list visible deleted Agents: %v", err)
	}
	if !store.query.IncludeDeleted || store.query.Limit != defaultAgentListLimit+1 || store.calls != 1 {
		t.Fatalf("include_deleted query was not preserved: query=%+v calls=%d", store.query, store.calls)
	}
}

func TestListAgentsRejectsInvalidFiltersBeforeStorage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input ListAgentsInput
	}{
		{name: "organization", input: ListAgentsInput{OrganizationID: "not valid"}},
		{name: "owner", input: ListAgentsInput{OwnerUserID: "not valid"}},
		{name: "lifecycle state", input: ListAgentsInput{LifecycleState: "lost"}},
		{name: "negative limit", input: ListAgentsInput{Limit: -1}},
		{name: "oversized limit", input: ListAgentsInput{Limit: maximumAgentListLimit + 1}},
		{name: "cursor", input: ListAgentsInput{Cursor: "not-a-cursor"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &agentQueryStoreStub{}
			service := NewAgentQueryService(store)
			_, err := service.ListAgents(context.Background(), test.input)
			if !errors.Is(err, ErrInvalidInput) || store.calls != 0 {
				t.Fatalf("error=%v calls=%d", err, store.calls)
			}
		})
	}
}

func TestListAgentsRejectsStoreContractOverrun(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	store := &agentQueryStoreStub{records: []ports.AgentRecord{
		queryAgentRecord("agent-1", "user-1", domain.AgentAvailable, now),
		queryAgentRecord("agent-2", "user-1", domain.AgentAvailable, now),
		queryAgentRecord("agent-3", "user-1", domain.AgentAvailable, now),
	}}
	service := NewAgentQueryService(store)
	_, err := service.ListAgents(context.Background(), ListAgentsInput{Limit: 1})
	if !errors.Is(err, ErrQueryContract) {
		t.Fatalf("store overrun error = %v", err)
	}
}

func queryAgentRecord(
	agentID string, ownerUserID string, state domain.AgentState, createdAt time.Time,
) ports.AgentRecord {
	return ports.AgentRecord{
		AgentID: agentID, OrganizationID: "org-1", OwnerUserID: ownerUserID,
		Name: agentID, DesiredState: domain.DesiredEnabled, LifecycleState: state,
		AccessRevision: "access-1", AggregateSequence: 1,
		CreatedAt: createdAt, UpdatedAt: createdAt,
	}
}

type agentQueryStoreStub struct {
	record     ports.AgentRecord
	records    []ports.AgentRecord
	err        error
	getAgentID string
	query      ports.AgentQuery
	calls      int
}

func (store *agentQueryStoreStub) GetAgent(
	_ context.Context, agentID string,
) (ports.AgentRecord, error) {
	store.calls++
	store.getAgentID = agentID
	return store.record, store.err
}

func (store *agentQueryStoreStub) ListAgents(
	_ context.Context, query ports.AgentQuery,
) ([]ports.AgentRecord, error) {
	store.calls++
	store.query = query
	return store.records, store.err
}

var _ ports.AgentQueryStore = (*agentQueryStoreStub)(nil)
