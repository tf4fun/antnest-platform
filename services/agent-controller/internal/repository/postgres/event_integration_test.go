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
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentAvailable, now)
	insertQueryAgent(t, ctx, repository, "agent-b", "org-a", "user-b", domain.DesiredEnabled, domain.AgentAvailable, now)
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

func TestAgentEventRepositoryWaitClosesSubscribeRaceAndWakesOnCommit(t *testing.T) {
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
	insertQueryAgent(t, ctx, repository, "agent-a", "org-a", "user-a", domain.DesiredEnabled, domain.AgentAvailable, now)
	insertQueryAgent(t, ctx, repository, "agent-b", "org-a", "user-b", domain.DesiredEnabled, domain.AgentAvailable, now)
	sequence1 := insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-a-1", "agent-a", 1, now))

	immediateCtx, immediateCancel := context.WithTimeout(ctx, time.Second)
	defer immediateCancel()
	if err := repository.WaitForAgentEvents(immediateCtx, "", sequence1-1); err != nil {
		t.Fatalf("wait did not observe already-committed event: %v", err)
	}
	insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-b-1", "agent-b", 1, now.Add(time.Second)))
	filteredCtx, filteredCancel := context.WithTimeout(ctx, 50*time.Millisecond)
	err = repository.WaitForAgentEvents(filteredCtx, "agent-a", sequence1)
	filteredCancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("per-Agent wait observed unrelated event: %v", err)
	}

	waitCtx, waitCancel := context.WithTimeout(ctx, 3*time.Second)
	defer waitCancel()
	waitResult := make(chan error, 1)
	go func() { waitResult <- repository.WaitForAgentEvents(waitCtx, "agent-a", sequence1) }()
	time.Sleep(100 * time.Millisecond)
	insertTestAgentEvent(t, ctx, repository, testRepositoryEvent("event-a-2", "agent-a", 2, now.Add(2*time.Second)))
	if err := <-waitResult; err != nil {
		t.Fatalf("wait for committed event: %v", err)
	}

	cancelledCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	err = repository.WaitForAgentEvents(cancelledCtx, "", sequence1+2)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled wait error = %v", err)
	}
}

func testRepositoryEvent(
	eventID string, agentID string, aggregateSequence int64, occurredAt time.Time,
) ports.AgentEventRecord {
	return ports.AgentEventRecord{
		EventID: eventID, AgentID: agentID, AggregateSequence: aggregateSequence,
		SchemaVersion: 1, EventType: "agent_tested", TraceID: "0123456789abcdef0123456789abcdef",
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
	if err := insertAgentEvent(ctx, transaction, event); err != nil {
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
