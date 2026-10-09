package postgres

import (
	"context"

	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func observeRuntimeForTest(t *testing.T, ctx context.Context, repository *Repository, agent ports.AgentRecord,
	operation ports.LifecycleOperationRecord, id, process, endpoint string) {
	t.Helper()
	input := runtimeBindingInput(t, ctx, repository, agent, operation, id, process, endpoint)
	changed, err := repository.PublishRuntimeBinding(ctx, input)
	if err != nil || !changed {
		t.Fatalf("publish observed Runtime: changed=%t error=%v", changed, err)
	}
	changed, err = repository.PublishRuntimeBinding(ctx, input)
	if err != nil || changed {
		t.Fatalf("readiness replay was not idempotent: changed=%t error=%v", changed, err)
	}
}

func TestNeverReadyRuntimeCanRebuildDisableEnableAndDelete(t *testing.T) {
	for _, history := range []bool{false, true} {
		t.Run(map[bool]string{false: "without_history", true: "old_execution_on_previous_spec"}[history], func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, seed := seedConfiguredAgentForTest(t, ctx, repo, history)
			deps := newRuntimeRebuildDependencies(base.Agent)
			identity := &offboardingIdentity{principal: ports.IdentityPrincipal{
				UserID: base.Agent.OwnerUserID, OrganizationID: base.Agent.OrganizationID, MembershipID: "membership", Active: true,
			}}
			service := newIntegratedLifecycleService(repo, repo, deps, deps, offboardingClock{}, application.WithIdentityDirectory(identity), application.WithLifecycleExecution(testLifecycleExecution(repo)))
			input := application.RebuildAgentInput{RequestID: "rebuild-before-ready", AgentID: base.Agent.AgentID,
				TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
			if _, err := service.RebuildAgent(ctx, input); err != nil {
				t.Fatal(err)
			}
			finishOffboardingOperation(t, repo, service, input.RequestID, domain.OperationCompleted)
			pending, err := repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
			if err != nil || !pending.Agent.AwaitingRuntimeBinding() || pending.SourceExecution.ID != "" ||
				pending.ConfiguredSpec.ID == base.ConfiguredSpec.ID {
				t.Fatalf("configured target reused old execution/spec: %+v error=%v", pending, err)
			}
			assertExecutionClosed(t, repo, pending.Agent)
			disabled := seedDisabledAgentForEnable(t, ctx, repo, pending)
			if disabled.AgentSpecRevisionID != pending.ConfiguredSpec.ID || disabled.LastSuccessfulExecutionRevisionID != base.Agent.LastSuccessfulExecutionRevisionID {
				t.Fatalf("disable lost current spec or historical execution: %+v", disabled)
			}
			enabled, err := service.EnableAgent(ctx, application.EnableAgentInput{RequestID: "enable-before-ready", AgentID: disabled.AgentID})
			if err != nil {
				t.Fatal(err)
			}
			finishOffboardingOperation(t, repo, service, enabled.Operation.RequestID, domain.OperationCompleted)
			agent, err := repo.GetAgent(ctx, disabled.AgentID)
			if err != nil || !agent.AwaitingRuntimeBinding() || agent.AgentSpecRevisionID != pending.ConfiguredSpec.ID {
				t.Fatalf("enable did not preserve configured target: %+v error=%v", agent, err)
			}
			var executions int
			if err := repo.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.execution_revisions WHERE agent_id=$1", agent.AgentID).Scan(&executions); err != nil {
				t.Fatal(err)
			}
			expected := 0
			if history {
				expected = 1
			}
			if executions != expected {
				t.Fatalf("unobserved lifecycle created %d executions, want %d", executions, expected)
			}
			page, err := repo.ListPendingRuntimeBindings(ctx, "", 500)
			if err != nil || len(page) != 1 || page[0].Spec.ID != pending.ConfiguredSpec.ID {
				t.Fatalf("pending target=%+v error=%v", page, err)
			}
			// The complete deletion workflow must not need a successful MCP execution either.
			deleteDeps := &deleteRetryDependencies{offboardingDependencies: &deps.offboardingDependencies, calls: make(map[string]int)}
			deleteService := newIntegratedLifecycleService(repo, repo, deleteDeps, deleteDeps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repo)))
			deletion, err := deleteService.DeleteAgent(ctx, application.DeleteAgentInput{RequestID: "delete-before-ready", AgentID: agent.AgentID})
			if err != nil || deletion.Operation.State != domain.OperationRunning {
				t.Fatalf("delete pending Agent=%+v error=%v", deletion, err)
			}
			finishOffboardingOperation(t, repo, deleteService, deletion.Operation.RequestID, domain.OperationCompleted)
			deleted, err := repo.GetAgent(ctx, agent.AgentID)
			if err != nil || deleted.LifecycleState != domain.AgentDeleted || deleteDeps.releases != 1 {
				t.Fatalf("delete never-ready resources: %+v releases=%d error=%v", deleted, deleteDeps.releases, err)
			}
		})
	}
}

func TestRestartObservationFencesInFlightFirstBinding(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	page, err := repo.ListPendingRuntimeBindings(ctx, "", 500)
	if err != nil || len(page) != 1 {
		t.Fatalf("pending=%+v error=%v", page, err)
	}
	pending := page[0]
	now := time.Now().UTC()
	stale := ports.PublishRuntimeBinding{
		ExpectedAggregateSequence: pending.Agent.AggregateSequence, OperationRequestID: pending.Operation.RequestID,
		Execution: ports.ExecutionRecord{ID: "stale", AgentID: base.Agent.AgentID, Revision: 1,
			AgentSpecRevisionID: pending.Spec.ID, RuntimeRevision: base.Agent.RuntimeRevision,
			RuntimeExecutionID: "old-process", RuntimeMCPEndpoint: "http://old:8091/mcp",
			RuntimeMCPSourceDigest: strings.Repeat("a", 64), PublishedAt: now},
		ReadyEvent: ports.AgentEventRecord{EventID: "stale-ready", AgentID: base.Agent.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentReady, OperationRequestID: pending.Operation.RequestID, Data: map[string]any{}, OccurredAt: now},
	}
	// This is the exact interleaving of Inspect(E1), consume restart(E2), publish(E1).
	if err := repo.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{Sequence: 1, AgentID: base.Agent.AgentID,
		RuntimeRevision: base.Agent.RuntimeRevision, Kind: ports.RuntimeObservationRestarted,
		Current: &ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy", RuntimeExecutionID: "new-process", MCPEndpoint: "http://new:8091/mcp", ObservedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatal(err)
	}
	if changed, err := repo.PublishRuntimeBinding(ctx, stale); err != nil || changed {
		t.Fatalf("stale publication=%t error=%v", changed, err)
	}
	agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	observeRuntimeForTest(t, ctx, repo, agent, pending.Operation, "fresh", "new-process", "http://new:8091/mcp")
	if err := repo.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{Sequence: 2, AgentID: agent.AgentID,
		RuntimeRevision: agent.RuntimeRevision, Kind: ports.RuntimeObservationRestarted,
		Current: &ports.RuntimeInspection{AgentID: agent.AgentID, RuntimeRevision: agent.RuntimeRevision,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy", RuntimeExecutionID: "new-process", MCPEndpoint: "http://new:8091/mcp", ObservedAt: time.Now().UTC()},
	}); err != nil {
		t.Fatal(err)
	}
	current, err := repo.GetAgent(ctx, agent.AgentID)
	if err != nil || (current.LifecycleState != domain.AgentCreated || current.ActivationState != domain.ActivationEnabled || current.RuntimeState != domain.RuntimeAvailable) {
		t.Fatalf("late event invalidated current observation: %+v error=%v", current, err)
	}
}

func TestNeverReadyRejectedRebuildRestoresNetworkBeforePublication(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, seed := seedConfiguredAgentForTest(t, ctx, repo, false)
	deps := newRuntimeRebuildDependencies(base.Agent)
	deps.updateError = &ports.DependencyError{Service: "runtime-controller", Code: "image_not_found"}
	deps.inspection = &ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, LifecycleState: "provisioned", Phase: "running", RuntimeEndpoint: "10.20.0.9", TunnelKeyID: "rtk_0123456789abcdef0123456789abcdef", Health: "starting"}
	service, worker := runtimeRebuildServices(t, repo, deps)
	input := application.RebuildAgentInput{RequestID: "rejected-before-ready", AgentID: base.Agent.AgentID,
		TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
	if _, err := service.RebuildAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	finishOffboardingOperation(t, repo, worker, input.RequestID, domain.OperationFailed)
	agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || !agent.AwaitingRuntimeBinding() || deps.network.AttachmentState != ports.NetworkAttachmentOpen {
		t.Fatalf("pending source not safely restored: %+v network=%+v error=%v", agent, deps.network, err)
	}
	assertExecutionClosed(t, repo, agent)
}

func runtimeBindingInput(t *testing.T, ctx context.Context, repository *Repository, agent ports.AgentRecord,
	operation ports.LifecycleOperationRecord, id, process, endpoint string) ports.PublishRuntimeBinding {
	t.Helper()
	_, next, err := loadNextLifecycleRevisions(ctx, repository.pool, agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	input := ports.PublishRuntimeBinding{
		ExpectedAggregateSequence: agent.AggregateSequence, OperationRequestID: operation.RequestID,
		Execution: ports.ExecutionRecord{
			ID: id, AgentID: agent.AgentID, Revision: next,
			AgentSpecRevisionID: agent.AgentSpecRevisionID, RuntimeRevision: agent.RuntimeRevision,
			RuntimeExecutionID: process, RuntimeMCPEndpoint: endpoint,
			RuntimeMCPSourceDigest: strings.Repeat("b", 64), ChangeSummary: map[string]any{"kind": operation.Kind},
			PublishedAt: now,
		},
		ReadyEvent: ports.AgentEventRecord{
			EventID: "ready-" + id, AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentReady, OperationRequestID: operation.RequestID,
			Data: map[string]any{"execution_revision_id": id}, OccurredAt: now,
		},
	}
	return input
}

func TestPendingRuntimePublicationHonorsLifecycleAndOwnerFences(t *testing.T) {
	for _, change := range []string{"disable", "rebuild", "owner_revoke"} {
		t.Run(change, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
			op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
			if err != nil {
				t.Fatal(err)
			}
			input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "late", "process", "http://runtime:8091/mcp")
			switch change {
			case "disable":
				seedDisabledAgentForEnable(t, ctx, repo, base)
			case "rebuild":
				if _, err := repo.pool.Exec(ctx, "UPDATE agent_controller.agents SET active_operation_request_id='new-rebuild', aggregate_sequence=aggregate_sequence+1 WHERE id=$1", base.Agent.AgentID); err != nil {
					t.Fatal(err)
				}
			case "owner_revoke":
				if err := repo.ApplyIdentityRevocation(ctx, 0, ports.PrincipalRevocation{
					Sequence: 1, UserID: base.Agent.OwnerUserID, OrganizationID: base.Agent.OrganizationID,
					Reason: "membership_deactivated", OccurredAt: time.Now().UTC(),
				}, ""); err != nil {
					t.Fatal(err)
				}
			}
			changed, err := repo.PublishRuntimeBinding(ctx, input)
			if err != nil || changed {
				t.Fatalf("stale binding admitted after %s: %t %v", change, changed, err)
			}
			var executions int
			if err := repo.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.execution_revisions WHERE agent_id=$1", base.Agent.AgentID).Scan(&executions); err != nil || executions != 0 {
				t.Fatalf("rejected observation retained execution: %d error=%v", executions, err)
			}
		})
	}
}

func TestRuntimeCursorReconciliationFencesInFlightFirstBinding(t *testing.T) {
	for _, test := range []struct {
		name  string
		reset bool
		empty bool
	}{
		{name: "bootstrap"},
		{name: "bootstrap_empty_inventory", empty: true},
		{name: "reset", reset: true},
		{name: "reset_empty_inventory", reset: true, empty: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
			page, err := repo.ListPendingRuntimeBindings(ctx, "", 500)
			if err != nil || len(page) != 1 {
				t.Fatalf("pending=%+v error=%v", page, err)
			}
			op := page[0].Operation
			stale := runtimeBindingInput(t, ctx, repo, base.Agent, op, "stale", "old-process", "http://old:8091/mcp")
			snapshots := []ports.RuntimeEnvironmentSnapshot{{
				AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				LifecycleState: "provisioned", Health: "healthy", RuntimeExecutionID: "new-process",
			}}
			if test.empty {
				snapshots = nil
			}
			if test.reset {
				err = repo.ResetRuntimeObservationCursor(ctx, snapshots, 1)
			} else {
				err = repo.InitializeRuntimeObservationCursor(ctx, snapshots)
			}
			if err != nil {
				t.Fatal(err)
			}
			if changed, err := repo.PublishRuntimeBinding(ctx, stale); err != nil || changed {
				t.Fatalf("stale publication=%t error=%v", changed, err)
			}
			agent, err := repo.GetAgent(ctx, base.Agent.AgentID)
			if err != nil || !agent.AwaitingRuntimeBinding() {
				t.Fatalf("pending target=%+v error=%v", agent, err)
			}
			observeRuntimeForTest(t, ctx, repo, agent, op, "fresh", "new-process", "http://new:8091/mcp")
		})
	}
}
