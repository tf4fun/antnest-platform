package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type inspectionCatalogStoreStub struct {
	catalogStoreStub
	usage       ports.ModelProfileUsage
	usageErr    error
	events      []ports.ModelProfileRevisedEvent
	eventsErr   error
	usageOrg    string
	usageModel  string
	eventsOrg   string
	eventsModel string
	eventsAfter int64
	eventsLimit int
	unsupported bool
}

func (store *inspectionCatalogStoreStub) GetModelProfileUsage(
	_ context.Context, organizationID, modelID string,
) (ports.ModelProfileUsage, error) {
	store.usageOrg, store.usageModel = organizationID, modelID
	return store.usage, store.usageErr
}

func (store *inspectionCatalogStoreStub) ListModelProfileEvents(
	_ context.Context, organizationID, modelID string, afterRevision int64, limit int,
) ([]ports.ModelProfileRevisedEvent, error) {
	store.eventsOrg, store.eventsModel, store.eventsAfter, store.eventsLimit = organizationID, modelID, afterRevision, limit
	return store.events, store.eventsErr
}

func modelInspectionService(store ports.CatalogStore) *CatalogService {
	return NewCatalogService(store, nil, nil)
}

func revisedEventFixture(revision int64) ports.ModelProfileRevisedEvent {
	return ports.ModelProfileRevisedEvent{
		EventType: ports.EventModelProfileRevised, RequestID: "request-event",
		OrganizationID: "org-1", ModelProfileID: "model-1",
		RevisionID: "revision-event", PreviousRevision: revision - 1, Revision: revision,
		OccurredAt: time.Unix(100, 0).UTC(),
	}
}

func TestModelProfileUsageIsScopedAndValidated(t *testing.T) {
	t.Parallel()

	store := &inspectionCatalogStoreStub{usage: ports.ModelProfileUsage{Templates: 3, Agents: 7}}
	usage, err := modelInspectionService(store).GetModelProfileUsage(context.Background(), "org-1", "model-1")
	if err != nil || usage != store.usage {
		t.Fatalf("usage: %+v %v", usage, err)
	}
	if store.usageOrg != "org-1" || store.usageModel != "model-1" {
		t.Fatalf("unscoped usage query: %q %q", store.usageOrg, store.usageModel)
	}
	for _, pair := range [][2]string{{"", "model-1"}, {"org-1", ""}, {"bad id", "model-1"}} {
		if _, err := modelInspectionService(store).GetModelProfileUsage(
			context.Background(), pair[0], pair[1]); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid scope %v: %v", pair, err)
		}
	}
	store.usageErr = ports.ErrNotFound
	if _, err := modelInspectionService(store).GetModelProfileUsage(
		context.Background(), "org-1", "model-1"); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("unknown or cross-organization profile must fail closed: %v", err)
	}
}

func TestModelProfileUsageFailsClosedOnStoreContractViolations(t *testing.T) {
	t.Parallel()

	if _, err := modelInspectionService(&catalogStoreStub{}).GetModelProfileUsage(
		context.Background(), "org-1", "model-1"); !errors.Is(err, ErrQueryContract) {
		t.Fatalf("store without inspection support must fail closed: %v", err)
	}
	for _, usage := range []ports.ModelProfileUsage{
		{Templates: -1}, {Agents: -1}, {Templates: domain.MaximumSafeInteger + 1},
	} {
		store := &inspectionCatalogStoreStub{usage: usage}
		if _, err := modelInspectionService(store).GetModelProfileUsage(
			context.Background(), "org-1", "model-1"); !errors.Is(err, ErrQueryContract) {
			t.Fatalf("invalid usage counts accepted: %+v", usage)
		}
	}
}

func TestModelProfileEventsPaginateByRevision(t *testing.T) {
	t.Parallel()

	events := []ports.ModelProfileRevisedEvent{revisedEventFixture(2), revisedEventFixture(3), revisedEventFixture(4)}
	for _, test := range []struct {
		name      string
		limit     int
		wantItems int
		wantNext  *int64
		wantLimit int
	}{
		{name: "default page", limit: 0, wantItems: 3, wantLimit: 50},
		{name: "bounded page", limit: 2, wantItems: 2, wantNext: &[]int64{3}[0], wantLimit: 2},
	} {
		store := &inspectionCatalogStoreStub{events: events}
		page, err := modelInspectionService(store).ListModelProfileEvents(
			context.Background(), "org-1", "model-1", 0, test.limit)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		if store.eventsLimit != test.wantLimit || store.eventsOrg != "org-1" || store.eventsModel != "model-1" {
			t.Fatalf("%s scope: %v", test.name, store)
		}
		if len(page.Items) != test.wantItems {
			t.Fatalf("%s items: %+v", test.name, page.Items)
		}
		if test.wantNext == nil && page.NextAfterRevision != nil ||
			test.wantNext != nil && (page.NextAfterRevision == nil || *page.NextAfterRevision != *test.wantNext) {
			t.Fatalf("%s next cursor: %+v", test.name, page.NextAfterRevision)
		}
	}
	store := &inspectionCatalogStoreStub{events: events}
	if _, err := modelInspectionService(store).ListModelProfileEvents(
		context.Background(), "org-1", "model-1", 1, 0); err != nil || store.eventsAfter != 1 {
		t.Fatalf("after cursor was not forwarded: %v", err)
	}
	for _, input := range []struct {
		after  int64
		limit  int
		reason string
	}{
		{-1, 0, "negative cursor"}, {domain.MaximumSafeInteger + 1, 0, "unsafe cursor"},
		{0, -1, "negative limit"}, {0, 101, "oversize limit"},
	} {
		if _, err := modelInspectionService(store).ListModelProfileEvents(
			context.Background(), "org-1", "model-1", input.after, input.limit); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s accepted: %v", input.reason, err)
		}
	}
	if _, err := modelInspectionService(&catalogStoreStub{}).ListModelProfileEvents(
		context.Background(), "org-1", "model-1", 0, 0); !errors.Is(err, ErrQueryContract) {
		t.Fatalf("store without inspection support must fail closed: %v", err)
	}
	store.eventsErr = ports.ErrNotFound
	if _, err := modelInspectionService(store).ListModelProfileEvents(
		context.Background(), "org-1", "model-1", 0, 0); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("unknown or cross-organization profile must fail closed: %v", err)
	}
}

func TestModelProfileEventsFailClosedOnMalformedRows(t *testing.T) {
	t.Parallel()

	valid := revisedEventFixture(2)
	for _, mutate := range []func(*ports.ModelProfileRevisedEvent){
		func(event *ports.ModelProfileRevisedEvent) { event.EventType = "agent_rebuilt" },
		func(event *ports.ModelProfileRevisedEvent) { event.OrganizationID = "org-2" },
		func(event *ports.ModelProfileRevisedEvent) { event.ModelProfileID = "model-2" },
		func(event *ports.ModelProfileRevisedEvent) { event.RequestID = "" },
		func(event *ports.ModelProfileRevisedEvent) { event.PreviousRevision = 0 },
		func(event *ports.ModelProfileRevisedEvent) { event.Revision = event.PreviousRevision },
		func(event *ports.ModelProfileRevisedEvent) { event.Revision = domain.MaximumSafeInteger + 1 },
		func(event *ports.ModelProfileRevisedEvent) { event.OccurredAt = time.Time{} },
	} {
		event := valid
		mutate(&event)
		store := &inspectionCatalogStoreStub{events: []ports.ModelProfileRevisedEvent{event}}
		if _, err := modelInspectionService(store).ListModelProfileEvents(
			context.Background(), "org-1", "model-1", 0, 0); !errors.Is(err, ErrQueryContract) {
			t.Fatalf("malformed event accepted: %+v", event)
		}
	}
	store := &inspectionCatalogStoreStub{events: []ports.ModelProfileRevisedEvent{revisedEventFixture(3)}}
	if _, err := modelInspectionService(store).ListModelProfileEvents(
		context.Background(), "org-1", "model-1", 3, 0); !errors.Is(err, ErrQueryContract) {
		t.Fatalf("stale cursor rows accepted: %v", err)
	}
}

func TestEffectiveModelProjectionFollowsCurrentHead(t *testing.T) {
	t.Parallel()

	store := &agentQueryStoreStub{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeWaiting,
		AccessRevision: "access-1", AgentSpecRevisionID: "spec-1",
		AggregateSequence: 1, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}, configuration: ports.AgentConfigurationRecord{
		AgentID: "agent-1", AgentSpecRevisionID: "spec-1", TemplateName: "Template",
		ModelProfileID: "model-1", ModelProfileName: "Model", ModelProfileRevision: 1,
		EffectiveModels: []ports.EffectiveModel{
			{ModelProfileID: "model-1", Revision: 2},
			{ModelProfileID: "model-2", Revision: 5},
			{ModelProfileID: "model-1", Revision: 2},
		},
		Snapshot: domain.AgentSpecSnapshot{
			TemplateID: "template-1", TemplateRevision: 1, ModelProfileID: "model-1",
			ModelProfileRevisionID: "model-revision-1", ModelProfileVersion: 1,
			MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1,
		},
	}}
	view, err := NewAgentQueryService(store).GetAgent(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("get Agent: %v", err)
	}
	if len(view.EffectiveModels) != 2 ||
		view.EffectiveModels[0] != (ports.EffectiveModel{ModelProfileID: "model-1", Revision: 2}) ||
		view.EffectiveModels[1] != (ports.EffectiveModel{ModelProfileID: "model-2", Revision: 5}) {
		t.Fatalf("effective models did not follow the current head in order: %+v", view.EffectiveModels)
	}
	if view.Configuration == nil || view.Configuration.ModelProfileRevision != 1 ||
		view.Configuration.ModelProfileRevisionID != "model-revision-1" {
		t.Fatalf("frozen configuration lineage changed: %+v", view.Configuration)
	}
}

func TestEffectiveModelProjectionOmitsWithoutSpecAndFailsClosedOnMalformedRows(t *testing.T) {
	t.Parallel()

	store := &agentQueryStoreStub{record: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1", Name: "Agent",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeWaiting,
		AccessRevision: "access-1", AggregateSequence: 1,
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}}
	view, err := NewAgentQueryService(store).GetAgent(context.Background(), "agent-1")
	if err != nil || view.EffectiveModels != nil || view.Configuration != nil {
		t.Fatalf("spec-less Agent must omit effective models: %+v %v", view.EffectiveModels, err)
	}
	store.record.AgentSpecRevisionID = "spec-1"
	store.configuration = ports.AgentConfigurationRecord{
		AgentID: "agent-1", AgentSpecRevisionID: "spec-1", EffectiveModels: []ports.EffectiveModel{},
	}
	if _, err := NewAgentQueryService(store).GetAgent(context.Background(), "agent-1"); !errors.Is(err, ErrQueryContract) {
		t.Fatalf("empty projection for a real spec must fail closed: %v", err)
	}
	for _, models := range [][]ports.EffectiveModel{
		{{ModelProfileID: "", Revision: 1}},
		{{ModelProfileID: "model-1", Revision: 0}},
		{{ModelProfileID: "model-1", Revision: -2}},
		{{ModelProfileID: "model-1", Revision: domain.MaximumSafeInteger + 1}},
	} {
		store.configuration.EffectiveModels = models
		if _, err := NewAgentQueryService(store).GetAgent(context.Background(), "agent-1"); !errors.Is(err, ErrQueryContract) {
			t.Fatalf("malformed effective models accepted: %+v", models)
		}
	}
}
