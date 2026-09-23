package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentEventRepositoryReplaysGlobalAndPerAgentOrder(t *testing.T) {
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

	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentCreated, now)
	insertQueryAgent(t, ctx, repository, "agent-b", "org-a", "user-b", domain.DesiredEnabled, domain.AgentCreated, now)
	sequence1 := insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-a-1", "agent-a", 1, now))
	sequence2 := insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-b-1", "agent-b", 1, now.Add(time.Second)))
	sequence3 := insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-a-2", "agent-a", 2, now.Add(2*time.Second)))

	global, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{
		AfterSequence: sequence1, Limit: 10,
	})
	if err != nil {
		t.Fatalf("list global events: %v", err)
	}
	if len(global) != 2 || global[0].GlobalSequence != sequence2 ||
		global[1].GlobalSequence != sequence3 || global[0].AgentID != "agent-b" ||
		global[1].Data["step"] != "event-a-2" {
		t.Fatalf("global events = %+v", global)
	}

	perAgent, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{
		AgentID: "agent-a", AfterSequence: 0, Limit: 10,
	})
	if err != nil {
		t.Fatalf("list per-Agent events: %v", err)
	}
	if len(perAgent) != 2 || perAgent[0].GlobalSequence != sequence1 ||
		perAgent[1].GlobalSequence != sequence3 {
		t.Fatalf("per-Agent events = %+v", perAgent)
	}

	limited, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{AfterSequence: 0, Limit: 1})
	if err != nil || len(limited) != 1 || limited[0].GlobalSequence != sequence1 {
		t.Fatalf("limited events=%+v err=%v", limited, err)
	}
}

func TestAgentEventNotifierFansOutCommitWithoutUsingBusinessPool(t *testing.T) {
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
	notifier, err := OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open Agent event notifier: %v", err)
	}
	t.Cleanup(notifier.Close)

	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentCreated, now)
	first, err := notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatalf("subscribe first watcher: %v", err)
	}
	second, err := notifier.SubscribeAgentEvents()
	if err != nil {
		t.Fatalf("subscribe second watcher: %v", err)
	}
	if acquired := repository.pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("subscriptions acquired %d business-pool connections", acquired)
	}
	insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-a-1", "agent-a", 1, now))
	for index, signal := range []<-chan struct{}{first, second} {
		select {
		case <-signal:
		case <-time.After(3 * time.Second):
			t.Fatalf("watcher %d did not receive committed event hint", index+1)
		}
	}
	pingCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := repository.Ping(pingCtx); err != nil {
		t.Fatalf("business pool unavailable after watcher fanout: %v", err)
	}
}

func TestAgentEventSequenceSerializesCommitVisibility(t *testing.T) {
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
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentCreated, now)
	insertQueryAgent(t, ctx, repository, "agent-b", "org-a", "user-b", domain.DesiredEnabled, domain.AgentCreated, now)

	first, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin first event transaction: %v", err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	if err := repository.insertAgentEvent(ctx, first, testRepositoryEvent("event-a-1", "agent-a", 1, now)); err != nil {
		t.Fatalf("insert first event: %v", err)
	}

	secondStarted := make(chan struct{})
	secondResult := make(chan error, 1)
	go func() {
		second, beginErr := repository.pool.Begin(ctx)
		if beginErr != nil {
			secondResult <- beginErr
			return
		}
		defer func() { _ = second.Rollback(ctx) }()
		close(secondStarted)
		if insertErr := repository.insertAgentEvent(
			ctx, second, testRepositoryEvent("event-b-1", "agent-b", 1, now.Add(time.Second)),
		); insertErr != nil {
			secondResult <- insertErr
			return
		}
		secondResult <- second.Commit(ctx)
	}()
	<-secondStarted
	select {
	case err := <-secondResult:
		t.Fatalf("second event transaction bypassed journal ordering lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit first event transaction: %v", err)
	}
	if err := <-secondResult; err != nil {
		t.Fatalf("commit second event transaction: %v", err)
	}

	events, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{AfterSequence: 0, Limit: 10})
	if err != nil {
		t.Fatalf("list commit-ordered events: %v", err)
	}
	if len(events) != 2 || events[0].EventID != "event-a-1" ||
		events[0].GlobalSequence != 1 || events[1].EventID != "event-b-1" ||
		events[1].GlobalSequence != 2 {
		t.Fatalf("commit-ordered events = %+v", events)
	}
}

func testRepositoryEvent(
	eventID string, agentID string, aggregateSequence int64, occurredAt time.Time,
) ports.AgentEventRecord {
	return ports.AgentEventRecord{
		EventID: eventID, AgentID: agentID, AggregateSequence: aggregateSequence,
		SchemaVersion: 1, EventType: ports.EventAgentReady, TraceID: "0123456789abcdef0123456789abcdef",
		Data: map[string]any{"step": eventID}, OccurredAt: occurredAt,
	}
}

func insertTestAgentEvent(
	t *testing.T, ctx context.Context, repository *Repository, event ports.AgentEventRecord,
) int64 {
	t.Helper()
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin event transaction: %v", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := repository.insertAgentEvent(ctx, transaction, event); err != nil {
		t.Fatalf("insert Agent event: %v", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit Agent event: %v", err)
	}
	var sequence int64
	if err := repository.pool.QueryRow(ctx, `
SELECT global_sequence FROM agent_controller.agent_events WHERE event_id = $1`, event.EventID).Scan(&sequence); err != nil {
		t.Fatalf("load Agent event sequence: %v", err)
	}
	return sequence
}
