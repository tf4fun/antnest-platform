package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func assertPreservedSourceRequiresFreshObservation(t *testing.T, ctx context.Context, repo *Repository, agent ports.AgentRecord) {
	t.Helper()
	assertExecutionClosed(t, repo, agent)
	_, err := repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: agent.AggregateSequence,
		Inspection: ports.RuntimeInspection{AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy", RuntimeExecutionID: agent.RuntimeExecutionID,
			MCPEndpoint: agent.RuntimeMCPEndpoint, ObservedAt: time.Now().UTC()},
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := repo.GetAgent(ctx, agent.AgentID)
	if err != nil || !after.Status().RuntimeReady() || after.ExecutionRevisionID != agent.ExecutionRevisionID {
		t.Fatalf("unchanged source failed to recover: %+v %v", after, err)
	}
}

func TestRuntimeConditionDoesNotRewriteCreatedLifecycleOrOperation(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	for index, test := range []struct {
		phase, health string
		state         domain.RuntimeState
	}{
		{"created", "starting", domain.RuntimeWaiting},
		{"running", "unhealthy", domain.RuntimeUnhealthy},
		{"exited", "unknown", domain.RuntimeExited},
		{"absent", "absent", domain.RuntimeAbsent},
		{"unknown", "unknown", domain.RuntimeUnknown},
	} {
		agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
			ExpectedAggregateSequence: agent.AggregateSequence,
			Inspection: ports.RuntimeInspection{AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
				LifecycleState: "provisioned", Phase: test.phase, Health: test.health,
				Reason: "test_observation", ObservedAt: time.Now().UTC().Add(time.Duration(index) * time.Second)},
		})
		if err != nil {
			t.Fatal(err)
		}
		got, err := repo.GetAgent(ctx, agent.AgentID)
		if err != nil || got.LifecycleState != domain.AgentCreated || got.ActivationState != domain.ActivationEnabled || got.RuntimeState != test.state {
			t.Fatalf("condition changed lifecycle: %+v %v", got, err)
		}
		assertExecutionClosed(t, repo, got)
		var state string
		if err := repo.pool.QueryRow(ctx, "SELECT state FROM agent_controller.agent_lifecycle_operations WHERE agent_id=$1 AND kind='create'", agent.AgentID).Scan(&state); err != nil || state != "completed" {
			t.Fatalf("observation rewrote operation: %s %v", state, err)
		}
	}
}

func TestRuntimeConditionCannotOverwriteNewerTargetOrDisabledAgent(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	input := ports.RecordRuntimeCondition{ExpectedAggregateSequence: base.Agent.AggregateSequence,
		Inspection: ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: "old-target", Phase: "running", Health: "healthy", ObservedAt: time.Now().UTC()}}
	if _, err := repo.RecordRuntimeCondition(ctx, input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("old revision accepted: %v", err)
	}
	disabled := seedDisabledAgentForEnable(t, ctx, repo, base)
	input.ExpectedAggregateSequence = disabled.AggregateSequence
	input.Inspection.RuntimeRevision = disabled.RuntimeRevision
	if _, err := repo.RecordRuntimeCondition(ctx, input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("disabled Agent updated: %v", err)
	}
}

func TestHealthRecoveryChecksExecutionIdentityAndCannotRebindLostTarget(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repo)
	for _, health := range []string{"unhealthy", "healthy"} {
		agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
		if err != nil {
			t.Fatal(err)
		}
		process := agent.RuntimeExecutionID
		if health == "healthy" {
			process = "unexpected-new-process"
		}
		_, err = repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
			ExpectedAggregateSequence: agent.AggregateSequence,
			Inspection: ports.RuntimeInspection{AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
				LifecycleState: "provisioned", Phase: "running", Health: health, RuntimeExecutionID: process,
				MCPEndpoint: base.Agent.RuntimeMCPEndpoint, ObservedAt: time.Now().UTC()},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.RuntimeState != domain.RuntimeAvailable || agent.ExecutionRevisionID != "" {
		t.Fatalf("healthy replacement retained an old binding: %+v %v", agent, err)
	}
	assertExecutionClosed(t, repo, agent)
	// A subsequent failed recovery changes failure reporting, not binding validity.
	if _, err := repo.pool.Exec(ctx, "UPDATE agent_controller.agents SET failure_stage='runtime_update', failure_code='image_not_found' WHERE id=$1", agent.AgentID); err != nil {
		t.Fatal(err)
	}
	agent, err = repo.GetAgent(ctx, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	if err != nil {
		t.Fatal(err)
	}
	input := runtimeBindingInput(t, ctx, repo, agent, operation, "forbidden-rebind", "unexpected-new-process", "http://runtime/mcp")
	if changed, err := repo.PublishRuntimeBinding(ctx, input); err != nil || changed {
		t.Fatalf("lost target was rebound after failed recovery: changed=%t err=%v", changed, err)
	}
}

func TestOldObservationCannotInvalidateNewerBinding(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repo)
	agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 1, AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision, Kind: ports.RuntimeObservationRestarted,
		Current: &ports.RuntimeInspection{AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "exited", Health: "unknown", ObservedAt: agent.RuntimeObservedAt.Add(-time.Second)},
	}); err != nil {
		t.Fatal(err)
	}
	after, err := repo.GetAgent(ctx, agent.AgentID)
	if err != nil || after.ExecutionRevisionID != agent.ExecutionRevisionID || after.AggregateSequence != agent.AggregateSequence {
		t.Fatalf("old observation invalidated current binding: %+v %v", after, err)
	}
	cursor, err := repo.GetRuntimeObservationCursor(ctx)
	if err != nil || cursor.Sequence != 1 {
		t.Fatalf("old event cursor was not consumed: %+v %v", cursor, err)
	}
}

func TestHealthCannotUndoLifecycleQuarantine(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repo)
	if _, err := repo.pool.Exec(ctx, "UPDATE agent_controller.agents SET failure_code='lifecycle_invariant_failed', runtime_state='unknown', executable_execution_revision_id='', runtime_execution_id='', runtime_mcp_endpoint='' WHERE id=$1", base.Agent.AgentID); err != nil {
		t.Fatal(err)
	}
	_, err := repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
		ExpectedAggregateSequence: base.Agent.AggregateSequence,
		Inspection: ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy", ObservedAt: time.Now().UTC()},
	})
	if !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("quarantined target accepted health: %v", err)
	}
}
