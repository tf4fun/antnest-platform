package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func gcSeedFailedCreate(
	t *testing.T, repository *Repository, base ports.AgentLifecycleBase, id string, age time.Duration,
) ports.LifecycleOperationRecord {
	t.Helper()
	operation := reliabilitySeedCreate(t, repository, base, id)
	termination := ports.TerminateLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, ErrorCode: "phase_deadline_exceeded",
		ErrorDetail: "create phase exceeded", EventID: "event-gc-term-" + id,
	}
	if _, err := repository.TerminateLifecycleOperation(context.Background(), termination); err != nil {
		t.Fatalf("fail create %s: %v", id, err)
	}
	aged := time.Now().UTC().Add(-age)
	if _, err := repository.pool.Exec(context.Background(),
		"UPDATE agent_controller.agent_lifecycle_operations SET updated_at = $1 WHERE request_id = $2",
		aged, operation.RequestID); err != nil {
		t.Fatalf("age create %s: %v", id, err)
	}
	operation.UpdatedAt = aged
	return operation
}

func gcListedAgentIDs(t *testing.T, repository *Repository, cutoff time.Time) []string {
	t.Helper()
	candidates, err := repository.ListFailedCreateGCCandidates(context.Background(), cutoff, 100)
	if err != nil {
		t.Fatal(err)
	}
	listed := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		listed = append(listed, candidate.AgentID)
	}
	return listed
}

func gcBeginDelete(
	agent ports.AgentRecord, operation ports.LifecycleOperationRecord,
	candidate ports.FailedCreateGCCandidate, cutoff time.Time, now time.Time,
) ports.BeginAgentDelete {
	deleteRequest := "gc-delete-" + agent.AgentID
	deadline := now.Add(time.Minute)
	return ports.BeginAgentDelete{
		AgentID: agent.AgentID, ExpectedAggregateSequence: agent.AggregateSequence,
		ExpectedDesiredState: agent.DesiredState, ExpectedLifecycleState: agent.LifecycleState,
		ExpectedRuntimeRevision: agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: deleteRequest, RequestFingerprint: strings.Repeat("d", 64),
			AgentID: agent.AgentID, Kind: domain.OperationDelete,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			DrainDeadlineAt:       &deadline,
			SourceRuntimeRevision: agent.RuntimeRevision,
			ChildRequestID:        domain.ChildRequestID(deleteRequest, domain.PhaseDrain),
			CreatedAt:             now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID:           domain.DeriveResourceID("event", "event-delete-requested", deleteRequest),
			AgentID:           agent.AgentID,
			AggregateSequence: agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType: ports.EventAgentDeleteRequested, OperationRequestID: deleteRequest,
			Data: map[string]any{"actor_principal_id": "system-failed-create-gc"}, OccurredAt: now,
		},
		FailedCreate: &candidate, FailedCreateCutoff: cutoff,
		GCEvent: &ports.AgentEventRecord{
			EventID:           domain.DeriveResourceID("event", "failed-create-gc", candidate.CreateRequestID),
			AgentID:           agent.AgentID,
			AggregateSequence: agent.AggregateSequence + 2, SchemaVersion: 1,
			EventType: ports.EventAgentGCScheduled, OperationRequestID: deleteRequest,
			Data: map[string]any{
				"create_request_id":  candidate.CreateRequestID,
				"delete_request_id":  deleteRequest,
				"actor_principal_id": "system-failed-create-gc",
			}, OccurredAt: now,
		},
		Now: now,
	}
}

func gcCandidateFor(agent ports.AgentRecord, operation ports.LifecycleOperationRecord) ports.FailedCreateGCCandidate {
	return ports.FailedCreateGCCandidate{
		AgentID: agent.AgentID, OrganizationID: agent.OrganizationID,
		CreateRequestID: operation.RequestID, AggregateSequence: agent.AggregateSequence,
	}
}

func gcInsertReadyEvent(t *testing.T, repository *Repository, agentID string, aggregate int64, now time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{
		EventID: domain.DeriveResourceID("event", "gc-ever-ready", agentID),
		AgentID: agentID, AggregateSequence: aggregate, SchemaVersion: 1,
		EventType: ports.EventAgentReady, Data: map[string]any{}, OccurredAt: now,
	}); err != nil {
		t.Fatalf("insert ready event: %v", err)
	}
	if _, err := tx.Exec(ctx,
		"UPDATE agent_controller.agents SET aggregate_sequence = $2 WHERE id = $1",
		agentID, aggregate); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func gcInsertExecutionHistory(t *testing.T, repository *Repository, agent ports.AgentRecord, now time.Time) string {
	t.Helper()
	ctx := context.Background()
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	execution := ports.ExecutionRecord{
		ID: "exec-gc-" + agent.AgentID, AgentID: agent.AgentID, Revision: 1,
		AgentSpecRevisionID:    agent.AgentSpecRevisionID,
		RuntimeRevision:        agent.RuntimeRevision,
		RuntimeExecutionID:     "gc-process-" + agent.AgentID,
		RuntimeMCPEndpoint:     "http://gc-runtime:8091/mcp",
		RuntimeMCPSourceDigest: strings.Repeat("a", 64),
		ChangeSummary:          map[string]any{}, PublishedAt: now,
	}
	if err := insertExecutionRevision(ctx, tx, execution); err != nil {
		t.Fatalf("insert execution history: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return execution.ID
}

func gcInsertTerminalOperation(t *testing.T, repository *Repository, agentID string, now time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertLifecycleOperation(ctx, tx, ports.LifecycleOperationRecord{
		RequestID: "op-second-" + agentID, RequestFingerprint: strings.Repeat("e", 64),
		AgentID: agentID, Kind: domain.OperationDelete,
		Phase: domain.PhaseDrain, State: domain.OperationFailed,
		ErrorCode: "agent_not_ready", ErrorDetail: "drain refused",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("insert second lifecycle: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestListFailedCreateGCCandidatesEligibility(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	old := gcSeedFailedCreate(t, repository, base, "gc-eligible", 8*24*time.Hour)
	recent := gcSeedFailedCreate(t, repository, base, "gc-recent", 24*time.Hour)
	listed := map[string]bool{}
	for _, id := range gcListedAgentIDs(t, repository, cutoff) {
		listed[id] = true
	}
	if !listed[old.AgentID] {
		t.Fatal("aged sole failed create must be listed")
	}
	if listed[recent.AgentID] {
		t.Fatal("recent failed create must not be listed")
	}
	agent, err := loadAgentRecord(ctx, repository.pool, old.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if agent.ActiveOperationRequestID != "" || agent.LifecycleState != domain.AgentNotCreated ||
		agent.DesiredState == domain.DesiredDeleted {
		t.Fatalf("candidate agent state: %+v", agent)
	}
	exclusions := []struct {
		name   string
		mutate func(agentID string)
	}{
		{"desired deleted", func(agentID string) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET desired_state = 'deleted' WHERE id = $1", agentID); err != nil {
				t.Fatal(err)
			}
		}},
		{"lifecycle created", func(agentID string) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET lifecycle_state = 'created', activation_state = 'enabled' WHERE id = $1", agentID); err != nil {
				t.Fatal(err)
			}
		}},
		{"active operation", func(agentID string) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET active_operation_request_id = 'op-active' WHERE id = $1", agentID); err != nil {
				t.Fatal(err)
			}
		}},
		{"executable pointer", func(agentID string) {
			agent, err := loadAgentRecord(ctx, repository.pool, agentID)
			if err != nil {
				t.Fatal(err)
			}
			executionID := gcInsertExecutionHistory(t, repository, agent, time.Now().UTC())
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET executable_execution_revision_id = $2 WHERE id = $1",
				agentID, executionID); err != nil {
				t.Fatal(err)
			}
		}},
		{"execution history", func(agentID string) {
			agent, err := loadAgentRecord(ctx, repository.pool, agentID)
			if err != nil {
				t.Fatal(err)
			}
			executionID := gcInsertExecutionHistory(t, repository, agent, time.Now().UTC())
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET last_successful_execution_revision_id = $2 WHERE id = $1",
				agentID, executionID); err != nil {
				t.Fatal(err)
			}
		}},
		{"physical revisions only", func(agentID string) {
			agent, err := loadAgentRecord(ctx, repository.pool, agentID)
			if err != nil {
				t.Fatal(err)
			}
			gcInsertExecutionHistory(t, repository, agent, time.Now().UTC())
		}},
		{"ever ready", func(agentID string) {
			agent, err := loadAgentRecord(ctx, repository.pool, agentID)
			if err != nil {
				t.Fatal(err)
			}
			gcInsertReadyEvent(t, repository, agentID, agent.AggregateSequence+1, time.Now().UTC())
		}},
		{"second lifecycle", func(agentID string) {
			gcInsertTerminalOperation(t, repository, agentID, time.Now().UTC())
		}},
	}
	for _, exclusion := range exclusions {
		t.Run(exclusion.name, func(t *testing.T) {
			fresh := gcSeedFailedCreate(t, repository, base, "gc-ex-"+strings.ReplaceAll(exclusion.name, " ", "-"), 8*24*time.Hour)
			exclusion.mutate(fresh.AgentID)
			for _, id := range gcListedAgentIDs(t, repository, cutoff) {
				if id == fresh.AgentID {
					t.Fatalf("%s must exclude the candidate", exclusion.name)
				}
			}
		})
	}
}

func TestBeginAgentDeleteGCRecheckAndEvents(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	operation := gcSeedFailedCreate(t, repository, base, "gc-delete-ok", 8*24*time.Hour)
	agent, err := loadAgentRecord(ctx, repository.pool, operation.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	candidate := gcCandidateFor(agent, operation)
	now := time.Now().UTC()
	state, replayed, err := repository.BeginAgentDelete(ctx, gcBeginDelete(agent, operation, candidate, cutoff, now))
	if err != nil {
		t.Fatal(err)
	}
	if replayed {
		t.Fatal("first admission must not report replay")
	}
	if state.Agent.AggregateSequence != agent.AggregateSequence+2 {
		t.Fatalf("GC sequence must advance by 2: %+v", state.Agent)
	}
	if reliabilityEvents(t, repository, "agent_gc_scheduled", operation.AgentID) != 1 {
		t.Fatal("agent_gc_scheduled event missing")
	}
	if reliabilityEvents(t, repository, "agent_delete_requested", operation.AgentID) != 1 {
		t.Fatal("agent_delete_requested event missing")
	}
	replayedState, replayed, err := repository.BeginAgentDelete(ctx, gcBeginDelete(agent, operation, candidate, cutoff, now))
	if err != nil {
		t.Fatal(err)
	}
	if !replayed {
		t.Fatal("replayed delete must be idempotent")
	}
	if replayedState.Agent.AggregateSequence != state.Agent.AggregateSequence {
		t.Fatal("replay mutated the agent sequence")
	}
	if reliabilityEvents(t, repository, "agent_gc_scheduled", operation.AgentID) != 1 {
		t.Fatal("replay duplicated the GC event")
	}
}

func TestBeginAgentDeleteGCRejectsStaleAndRacedCandidates(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	mutations := map[string]func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord){
		"stale sequence": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET aggregate_sequence = aggregate_sequence + 1 WHERE id = $1",
				agent.AgentID); err != nil {
				t.Fatal(err)
			}
		},
		"cutoff race": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agent_lifecycle_operations SET updated_at = clock_timestamp() WHERE request_id = $1",
				operation.RequestID); err != nil {
				t.Fatal(err)
			}
		},
		"active operation race": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET active_operation_request_id = 'op-active' WHERE id = $1",
				agent.AgentID); err != nil {
				t.Fatal(err)
			}
		},
		"ever ready race": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			gcInsertReadyEvent(t, repository, agent.AgentID, agent.AggregateSequence+1, time.Now().UTC())
		},
		"second lifecycle race": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			gcInsertTerminalOperation(t, repository, agent.AgentID, time.Now().UTC())
		},
		"desired deleted race": func(t *testing.T, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) {
			if _, err := repository.pool.Exec(ctx,
				"UPDATE agent_controller.agents SET desired_state = 'deleted' WHERE id = $1",
				agent.AgentID); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			operation := gcSeedFailedCreate(t, repository, base,
				"gc-race-"+strings.ReplaceAll(name, " ", "-"), 8*24*time.Hour)
			agent, err := loadAgentRecord(ctx, repository.pool, operation.AgentID)
			if err != nil {
				t.Fatal(err)
			}
			listed := map[string]bool{}
			for _, id := range gcListedAgentIDs(t, repository, cutoff) {
				listed[id] = true
			}
			if !listed[agent.AgentID] {
				t.Fatal("fixture must list before the race")
			}
			mutate(t, agent, operation)
			begin := gcBeginDelete(agent, operation, gcCandidateFor(agent, operation), cutoff, time.Now().UTC())
			_, _, err = repository.BeginAgentDelete(ctx, begin)
			if !errors.Is(err, ports.ErrConcurrentChange) {
				t.Fatalf("%s must reject with concurrent change: %v", name, err)
			}
			if _, err := loadLifecycleOperation(ctx, repository.pool, begin.Operation.RequestID, ""); !errors.Is(err, ports.ErrNotFound) {
				t.Fatalf("%s must leave no delete operation", name)
			}
			if reliabilityEvents(t, repository, "agent_gc_scheduled", operation.AgentID) != 0 {
				t.Fatalf("%s must emit no GC event", name)
			}
		})
	}
}
