package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeRestartObservationInvalidatesExecutableAgentAtomically(t *testing.T) {
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
	now := time.Date(2026, time.September, 2, 0, 0, 0, 0, time.UTC)
	insertQueryAgent(
		t, ctx, repository, "agent-runtime-restart", "org-1", "user-1",
		domain.DesiredEnabled, domain.AgentCreated, now,
	)
	const revision = "rtv_11111111111111111111111111111111"
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agents
SET executable_execution_revision_id = 'execution-revision-1',
    last_successful_execution_revision_id = 'execution-revision-1',
    runtime_revision = $2, runtime_execution_id = 'runtime-execution-1',
    runtime_mcp_endpoint = 'http://runtime:8091/mcp'
WHERE id = $1`, "agent-runtime-restart", revision); err != nil {
		t.Fatalf("prepare executable Agent: %v", err)
	}
	if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 1, AgentID: "agent-runtime-restart", RuntimeRevision: revision,
		Kind: ports.RuntimeObservationRestarted, ObservedAt: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("apply restart observation: %v", err)
	}
	agent, err := repository.GetAgent(ctx, "agent-runtime-restart")
	if err != nil {
		t.Fatalf("get invalidated Agent: %v", err)
	}
	if (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeUnknown) || agent.ExecutionRevisionID != "" ||
		agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" ||
		agent.LastSuccessfulExecutionRevisionID != "execution-revision-1" ||
		agent.FailureCode != "runtime_restarted" {
		t.Fatalf("invalidated Agent=%+v", agent)
	}
	events, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{
		AgentID: "agent-runtime-restart", Limit: 10,
	})
	if err != nil || len(events) != 1 || events[0].EventType != ports.EventAgentRuntimeRestarted {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 1, AgentID: "agent-runtime-restart", RuntimeRevision: revision,
		Kind: ports.RuntimeObservationRestarted, ObservedAt: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("replay restart observation: %v", err)
	}
	events, err = repository.ListAgentEvents(ctx, ports.AgentEventQuery{
		AgentID: "agent-runtime-restart", Limit: 10,
	})
	if err != nil || len(events) != 1 {
		t.Fatalf("replayed events=%+v err=%v", events, err)
	}
}
