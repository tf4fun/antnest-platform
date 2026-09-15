package application

import (
	"context"
	"errors"
	"strings"
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
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, AccessRevision: "access-1",
		AgentSpecRevisionID: "spec-3", ExecutionRevisionID: "execution-4",
		LastSuccessfulExecutionRevisionID: "execution-4", RuntimeRevision: "runtime-2",
		RuntimeExecutionID: "runtime-execution-2", RuntimeMCPEndpoint: "http://runtime/mcp",
		AggregateSequence: 9, CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}, configuration: ports.AgentConfigurationRecord{
		AgentID: "agent-1", AgentSpecRevisionID: "spec-3",
		TemplateName: "Research", ModelProfileID: "model-1",
		ModelProfileRevision: 4, ModelProfileName: "DeepSeek",
		Snapshot: domain.AgentSpecSnapshot{
			TemplateID: "template-1", TemplateRevision: 2,
			ModelProfileRevisionID: "model-revision-4",
			Model: domain.ModelSpec{
				BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat",
				ContextWindow: 128000, MaxOutputTokens: 8192,
			},
			MaxModelRequests: 24, ContextPolicyVersion: domain.ContextPolicyV1,
			Runtime: domain.RuntimeSpecInput{
				ImageRef: "antnest/runtime@sha256:" + strings.Repeat("a", 64),
				Resources: domain.RuntimeResources{
					MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
				},
			},
		},
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
	if store.configurationAgentID != "agent-1" || store.configurationSpecID != "spec-3" ||
		view.Configuration == nil || view.Configuration.TemplateName != "Research" ||
		view.Configuration.ModelProfileName != "DeepSeek" ||
		view.Configuration.Model.Model != "deepseek-chat" {
		t.Fatalf("configuration lineage was not preserved: store=%+v view=%+v", store, view)
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
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, AccessRevision: "access-1",
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
		queryAgentRecord("agent-1", "user-1", domain.AgentCreated, firstTime),
		queryAgentRecord("agent-2", "user-1", domain.AgentCreated, secondTime),
		queryAgentRecord("agent-3", "user-1", domain.AgentCreated, secondTime),
	}}
	service := NewAgentQueryService(store)

	page, err := service.ListAgents(context.Background(), ListAgentsInput{
		OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, Limit: 2,
	})
	if err != nil {
		t.Fatalf("list Agents: %v", err)
	}
	if len(page.Items) != 2 || page.NextCursor == "" {
		t.Fatalf("unexpected first page: %+v", page)
	}
	if store.query.Limit != 3 || store.query.IncludeDeleted ||
		store.query.OrganizationID != "org-1" || store.query.OwnerUserID != "user-1" ||
		(store.query.LifecycleState != domain.AgentCreated || store.query.ActivationState != domain.ActivationEnabled || store.query.RuntimeState != domain.RuntimeAvailable) {
		t.Fatalf("query filters were not preserved: %+v", store.query)
	}

	store.records = nil
	_, err = service.ListAgents(context.Background(), ListAgentsInput{
		OrganizationID: "org-1", OwnerUserID: "user-1",
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, Limit: 2, Cursor: page.NextCursor,
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
		queryAgentRecord("agent-1", "user-1", domain.AgentCreated, now),
		queryAgentRecord("agent-2", "user-1", domain.AgentCreated, now),
		queryAgentRecord("agent-3", "user-1", domain.AgentCreated, now),
	}}
	service := NewAgentQueryService(store)
	_, err := service.ListAgents(context.Background(), ListAgentsInput{Limit: 1})
	if !errors.Is(err, ErrQueryContract) {
		t.Fatalf("store overrun error = %v", err)
	}
}

func TestListWorkspaceAgentsReturnsMetadataAndOpaqueCursor(t *testing.T) {
	t.Parallel()

	first := time.Date(2026, time.September, 3, 8, 0, 0, 0, time.UTC)
	second := first.Add(time.Second)
	store := &agentQueryStoreStub{workspaceRecords: []ports.WorkspaceAgentRecord{
		{AgentID: "agent-ready", Name: "Ready", CreatedAt: first, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable},
		{AgentID: "agent-busy", Name: "Disabled", CreatedAt: second, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationDisabled, RuntimeState: domain.RuntimeExited},
		{AgentID: "agent-offline", Name: "Offline", CreatedAt: second.Add(time.Second)},
	}}
	service := NewAgentQueryService(store)

	page, err := service.ListWorkspaceAgents(context.Background(), ListWorkspaceAgentsInput{
		RequestID: "request-workspace", OrganizationID: "org-1", PrincipalID: "user-1", Limit: 2,
	})
	if err != nil {
		t.Fatalf("list workspace Agents: %v", err)
	}
	if len(page.Items) != 2 || page.NextCursor == "" ||
		page.Items[0] != (WorkspaceAgentView{AgentID: "agent-ready", Name: "Ready", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable}) ||
		page.Items[1] != (WorkspaceAgentView{AgentID: "agent-busy", Name: "Disabled", LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationDisabled, RuntimeState: domain.RuntimeExited}) {
		t.Fatalf("workspace page = %+v", page)
	}
	if store.workspaceQuery.OrganizationID != "org-1" ||
		store.workspaceQuery.PrincipalID != "user-1" || store.workspaceQuery.Limit != 3 {
		t.Fatalf("workspace query = %+v", store.workspaceQuery)
	}

	store.workspaceRecords = nil
	_, err = service.ListWorkspaceAgents(context.Background(), ListWorkspaceAgentsInput{
		RequestID: "request-next", OrganizationID: "org-1", PrincipalID: "user-1",
		Limit: 2, Cursor: page.NextCursor,
	})
	if err != nil {
		t.Fatalf("continue workspace Agents: %v", err)
	}
	if !store.workspaceQuery.AfterCreatedAt.Equal(second) ||
		store.workspaceQuery.AfterAgentID != "agent-busy" {
		t.Fatalf("workspace cursor = %+v", store.workspaceQuery)
	}
}

func TestListWorkspaceAgentsRejectsInvalidScopeBeforeStorage(t *testing.T) {
	t.Parallel()

	tests := []ListWorkspaceAgentsInput{
		{OrganizationID: "org-1", PrincipalID: "user-1"},
		{RequestID: "request-1", OrganizationID: "not valid", PrincipalID: "user-1"},
		{RequestID: "request-1", OrganizationID: "org-1", PrincipalID: "not valid"},
		{RequestID: "request-1", OrganizationID: "org-1", PrincipalID: "user-1", Limit: maximumAgentListLimit + 1},
		{RequestID: "request-1", OrganizationID: "org-1", PrincipalID: "user-1", Cursor: "invalid"},
	}
	for _, input := range tests {
		store := &agentQueryStoreStub{}
		_, err := NewAgentQueryService(store).ListWorkspaceAgents(context.Background(), input)
		if !errors.Is(err, ErrInvalidInput) || store.calls != 0 {
			t.Fatalf("input=%+v error=%v calls=%d", input, err, store.calls)
		}
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
	record               ports.AgentRecord
	records              []ports.AgentRecord
	err                  error
	getAgentID           string
	query                ports.AgentQuery
	workspaceRecords     []ports.WorkspaceAgentRecord
	workspaceQuery       ports.WorkspaceAgentQuery
	configuration        ports.AgentConfigurationRecord
	configurationErr     error
	configurationAgentID string
	configurationSpecID  string
	calls                int
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

func (store *agentQueryStoreStub) ListWorkspaceAgents(
	_ context.Context, query ports.WorkspaceAgentQuery,
) ([]ports.WorkspaceAgentRecord, error) {
	store.calls++
	store.workspaceQuery = query
	return store.workspaceRecords, store.err
}

func (store *agentQueryStoreStub) GetAgentConfiguration(
	_ context.Context, agentID string, agentSpecRevisionID string,
) (ports.AgentConfigurationRecord, error) {
	store.configurationAgentID = agentID
	store.configurationSpecID = agentSpecRevisionID
	return store.configuration, store.configurationErr
}

var _ ports.AgentQueryStore = (*agentQueryStoreStub)(nil)
