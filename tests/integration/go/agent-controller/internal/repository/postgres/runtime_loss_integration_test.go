package postgres

import (
	"context"
	"reflect"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeLossPublishesClosedBindingWithoutErasingManagementHistory(t *testing.T) {
	for _, kind := range []string{"runtime_missing", "runtime_deleted"} {
		t.Run(kind, func(t *testing.T) {
			ctx, repository, databaseURL := controllerTestConnection(t)
			base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
			now := time.Now().UTC()
			initial := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
			notifier, err := OpenEventNotifier(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(notifier.Close)
			signal, err := notifier.SubscribeAgentEvents()
			if err != nil {
				t.Fatal(err)
			}
			observation := ports.RuntimeObservation{
				Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: kind, ObservedAt: now,
			}
			if err := repository.ApplyRuntimeObservation(ctx, observation); err != nil {
				t.Fatal(err)
			}
			assertRuntimeLoss(t, ctx, repository, base.Agent, kind)
			awaitAgentNotification(t, ctx, signal)
			service := application.NewAgentQueryService(repository)
			page, err := service.ListWorkspaceAgents(ctx, application.ListWorkspaceAgentsInput{
				RequestID: "runtime-loss-list", OrganizationID: base.Agent.OrganizationID, PrincipalID: base.Agent.OwnerUserID,
			})
			if err != nil || len(page.Items) != 1 || page.Items[0].AgentID != base.Agent.AgentID {
				t.Fatalf("Runtime loss must not erase authorized metadata: page=%+v error=%v", page, err)
			}
			changed := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID)
			if changed.Revision != initial.Revision+1 {
				t.Fatal("Runtime loss did not publish its configuration change")
			}
			if publishedAgent(t, repository, base.Agent).Runtime != nil {
				t.Fatal("Runtime loss retained executable endpoint")
			}
			before := runtimeLossEvents(t, ctx, repository, base.Agent.AgentID)
			for _, sequence := range []uint64{1, 2} {
				observation.Sequence = sequence
				if err := repository.ApplyRuntimeObservation(ctx, observation); err != nil {
					t.Fatal(err)
				}
			}
			if after := runtimeLossEvents(t, ctx, repository, base.Agent.AgentID); !reflect.DeepEqual(before, after) {
				t.Fatal("duplicate loss notification appended another audit event")
			}
			if current := currentExecutionSnapshot(t, repository, base.Agent.OrganizationID); !reflect.DeepEqual(changed, current) {
				t.Fatal("duplicate observation changed execution configuration")
			}
			assertRuntimeCursor(t, ctx, repository, 2)
		})
	}
}

func TestRuntimeLossReconciliationUsesConfirmedAbsence(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(map[bool]string{false: "bootstrap", true: "expired_cursor"}[reset], func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
			snapshots := []ports.RuntimeEnvironmentSnapshot{{
				AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				LifecycleState: "provisioned", Health: "absent",
			}}
			apply := func() error { return repository.InitializeRuntimeObservationCursor(ctx, snapshots) }
			sequence := uint64(0)
			if reset {
				if err := repository.InitializeRuntimeObservationCursor(ctx, nil); err != nil {
					t.Fatal(err)
				}
				sequence = 10
				apply = func() error { return repository.ResetRuntimeObservationCursor(ctx, snapshots, sequence) }
			}
			if err := apply(); err != nil {
				t.Fatal(err)
			}
			assertRuntimeLoss(t, ctx, repository, base.Agent, "runtime_missing")
			before := runtimeLossEvents(t, ctx, repository, base.Agent.AgentID)
			if err := apply(); err != nil {
				t.Fatal(err)
			}
			if after := runtimeLossEvents(t, ctx, repository, base.Agent.AgentID); !reflect.DeepEqual(before, after) {
				t.Fatal("reconciliation duplicated loss event")
			}
			assertRuntimeCursor(t, ctx, repository, sequence)
		})
	}
}

func TestRuntimeLossDoesNotOverwriteNewRevisionOrLifecycle(t *testing.T) {
	cases := []struct {
		name string
		set  string
	}{
		{"new_revision", "runtime_revision = 'rtv_22222222222222222222222222222222'"},
		{"lifecycle_in_progress", "active_operation_request_id = 'pending-disable'"},
		{"disabled", "desired_state = 'disabled', activation_state = 'disabled', runtime_state = 'absent'"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
			if _, err := repository.pool.Exec(ctx, "UPDATE agent_controller.agents SET "+test.set+" WHERE id=$1", base.Agent.AgentID); err != nil {
				t.Fatal(err)
			}
			before, err := repository.GetAgent(ctx, base.Agent.AgentID)
			if err != nil {
				t.Fatal(err)
			}
			events := runtimeLossEvents(t, ctx, repository, base.Agent.AgentID)
			if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
				Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: "runtime_deleted", ObservedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			after, err := repository.GetAgent(ctx, base.Agent.AgentID)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("unrelated Agent state overwritten: before=%+v after=%+v error=%v", before, after, err)
			}
			if !reflect.DeepEqual(events, runtimeLossEvents(t, ctx, repository, base.Agent.AgentID)) {
				t.Fatal("ignored observation appended an event")
			}
			assertRuntimeCursor(t, ctx, repository, 1)
		})
	}
}

func TestRuntimeLossReconciliationDoesNotInferDeletionFromUncertainty(t *testing.T) {
	for _, health := range []string{"unknown", "unhealthy", "starting", "healthy"} {
		t.Run(health, func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
			if err := repository.InitializeRuntimeObservationCursor(ctx, []ports.RuntimeEnvironmentSnapshot{{
				AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				RuntimeExecutionID: base.Agent.RuntimeExecutionID, LifecycleState: "provisioned", Health: health,
			}}); err != nil {
				t.Fatal(err)
			}
			agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
			if err != nil || (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeAvailable) || agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID {
				t.Fatalf("uncertain/unchanged Runtime invalidated: %+v error=%v", agent, err)
			}
		})
	}
}

func TestRuntimeLossEventFailureRollsBackAgentAndCursor(t *testing.T) {
	ctx, repository, _ := controllerTestConnection(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	collision := domain.DeriveResourceID("event", "runtime-observation", "1")
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_events
SET event_id=$1 WHERE event_id='event-ready-for-rebuild'`, collision); err != nil {
		t.Fatal(err)
	}
	observation := ports.RuntimeObservation{
		Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
	}
	if err := repository.ApplyRuntimeObservation(ctx, observation); err == nil {
		t.Fatal("expected duplicate event ID to abort the transaction")
	}
	agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || !reflect.DeepEqual(agent, base.Agent) {
		t.Fatalf("failed transaction changed Agent: %+v error=%v", agent, err)
	}
	cursor, err := repository.GetRuntimeObservationCursor(ctx)
	if err != nil || cursor.Initialized || cursor.Sequence != 0 {
		t.Fatalf("failed transaction advanced cursor: %+v error=%v", cursor, err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_events
SET event_id='event-ready-for-rebuild' WHERE event_id=$1`, collision); err != nil {
		t.Fatal(err)
	}
	if err := repository.ApplyRuntimeObservation(ctx, observation); err != nil {
		t.Fatal(err)
	}
	assertRuntimeLoss(t, ctx, repository, base.Agent, "runtime_missing")
	assertRuntimeCursor(t, ctx, repository, 1)
}

func assertRuntimeLoss(t *testing.T, ctx context.Context, repository *Repository, before ports.AgentRecord, reason string) {
	t.Helper()
	agent, err := repository.GetAgent(ctx, before.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeUnknown) || agent.ExecutionRevisionID != "" ||
		agent.RuntimeMCPEndpoint != "" || agent.RuntimeExecutionID != "" || agent.FailureCode != reason ||
		agent.FailureStage != "runtime_observation" || agent.RuntimeRevision != before.RuntimeRevision ||
		agent.LastSuccessfulExecutionRevisionID != before.ExecutionRevisionID || agent.FailureDetail == "" {
		t.Fatalf("missing Runtime still executable or evidence lost: %+v", agent)
	}
	assertExecutionClosed(t, repository, before)
	events := runtimeLossEvents(t, ctx, repository, before.AgentID)
	if len(events) != 4 || events[3].EventType != "agent_runtime_missing" || events[3].Data["reason"] != reason {
		t.Fatalf("missing/wrong Runtime loss audit: %+v", events)
	}
}

func runtimeLossEvents(t *testing.T, ctx context.Context, repository *Repository, agentID string) []ports.AgentEventRecord {
	t.Helper()
	events, err := repository.ListAgentEvents(ctx, ports.AgentEventQuery{AgentID: agentID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func assertRuntimeCursor(t *testing.T, ctx context.Context, repository *Repository, sequence uint64) {
	t.Helper()
	cursor, err := repository.GetRuntimeObservationCursor(ctx)
	if err != nil || !cursor.Initialized || cursor.Sequence != sequence {
		t.Fatalf("cursor=%+v error=%v", cursor, err)
	}
}
