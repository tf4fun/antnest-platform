package postgres

import (
	"context"
	"errors"
	"reflect"
	"regexp"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeLossAuditSurvivesRealEventListAndWatch(t *testing.T) {
	ctx, repository, databaseURL := controllerTestConnection(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 7, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	notifier, err := OpenEventNotifier(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(notifier.Close)
	service := application.NewEventService(repository, notifier, repository)
	page, err := service.ListAgentEvents(ctx, application.ListAgentEventsInput{
		OrganizationID: base.Agent.OrganizationID, AgentID: base.Agent.AgentID, Limit: 100,
	})
	if err != nil || len(page.Events) != 4 {
		t.Fatalf("real event list=%+v error=%v", page, err)
	}
	loss := page.Events[3]
	if !regexp.MustCompile(`^event_[0-9a-f]{32}$`).MatchString(loss.EventID) {
		t.Fatalf("runtime event ID = %q", loss.EventID)
	}
	if loss.EventType != "agent_runtime_missing" || loss.Data["reason"] != "runtime_missing" ||
		loss.Data["runtime_revision"] != base.Agent.RuntimeRevision || loss.Data["observation_sequence"] != float64(7) ||
		loss.OperationRequestID != "" || loss.GlobalSequence != page.NextSequence {
		t.Fatalf("incorrect loss attribution: %+v", loss)
	}
	finished := errors.New("watch evidence received")
	err = service.WatchAgentEvents(ctx, base.Agent.OrganizationID, base.Agent.AgentID, page.Events[2].GlobalSequence,
		func(event application.AgentEventView) error {
			if !reflect.DeepEqual(event, loss) {
				t.Fatalf("watch/list disagreement: %+v / %+v", event, loss)
			}
			return finished
		})
	if !errors.Is(err, finished) {
		t.Fatalf("watch error=%v", err)
	}
}

func TestRuntimeLossReconciliationRollsBackWholePage(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(map[bool]string{false: "bootstrap", true: "reset"}[reset], func(t *testing.T) {
			ctx, repository, databaseURL := controllerTestConnection(t)
			base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
			insertQueryAgent(t, ctx, repository, "second-agent", "org-integration", "user-integration",
				domain.DesiredEnabled, domain.AgentCreated, time.Now().UTC())
			if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents
SET runtime_revision=$1, executable_execution_revision_id='second-binding', runtime_execution_id='second-execution', runtime_mcp_endpoint='http://second/mcp'
WHERE id='second-agent'`, base.Agent.RuntimeRevision); err != nil {
				t.Fatal(err)
			}
			snapshots := []ports.RuntimeEnvironmentSnapshot{
				{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, LifecycleState: "provisioned", Health: "absent"},
				{AgentID: "second-agent", RuntimeRevision: base.Agent.RuntimeRevision, LifecycleState: "provisioned", Health: "absent"},
			}
			collision := runtimeReconciliationEventID(snapshots[1])
			if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_events
SET event_id=$1 WHERE event_id='event-ready-for-rebuild'`, collision); err != nil {
				t.Fatal(err)
			}
			apply := func() error { return repository.InitializeRuntimeObservationCursor(ctx, snapshots) }
			if reset {
				if err := repository.ResetRuntimeObservationCursor(ctx, nil, 3); err != nil {
					t.Fatal(err)
				}
				apply = func() error { return repository.ResetRuntimeObservationCursor(ctx, snapshots, 9) }
			}
			notifier, err := OpenEventNotifier(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(notifier.Close)
			signal, err := notifier.SubscribeAgentEvents()
			if err != nil {
				t.Fatal(err)
			}
			before := runtimePageState(t, ctx, repository, snapshots)
			if err := apply(); err == nil {
				t.Fatal("expected second event collision to abort the entire page")
			}
			after := runtimePageState(t, ctx, repository, snapshots)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("failed page changed an Agent, event journal or consumer cursor")
			}
			assertNoAgentNotification(t, signal)
			if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_events
SET event_id='event-ready-for-rebuild' WHERE event_id=$1`, collision); err != nil {
				t.Fatal(err)
			}
			if err := apply(); err != nil {
				t.Fatal(err)
			}
			awaitAgentNotification(t, ctx, signal)
			for _, snapshot := range snapshots {
				agent, err := repository.GetAgent(ctx, snapshot.AgentID)
				if err != nil || (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeUnknown) || agent.FailureCode != "runtime_missing" {
					t.Fatalf("retry did not invalidate Agent: %+v error=%v", agent, err)
				}
			}
			state := runtimePageState(t, ctx, repository, snapshots)
			if len(state.events) != len(before.events)+2 || state.journal != before.journal+2 {
				t.Fatal("retry did not publish exactly two loss events")
			}
		})
	}
}

type runtimeLossPageState struct {
	agents  []ports.AgentRecord
	events  []ports.AgentEventRecord
	cursor  ports.RuntimeObservationCursor
	journal int64
}

func runtimePageState(t *testing.T, ctx context.Context, repository *Repository, snapshots []ports.RuntimeEnvironmentSnapshot) runtimeLossPageState {
	t.Helper()
	var result runtimeLossPageState
	for _, snapshot := range snapshots {
		agent, err := repository.GetAgent(ctx, snapshot.AgentID)
		if err != nil {
			t.Fatal(err)
		}
		result.agents = append(result.agents, agent)
	}
	var err error
	result.events, err = repository.ListAgentEvents(ctx, ports.AgentEventQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	result.cursor, err = repository.GetRuntimeObservationCursor(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.pool.QueryRow(ctx, "SELECT last_sequence FROM agent_controller.event_journal_cursor WHERE singleton=TRUE").Scan(&result.journal); err != nil {
		t.Fatal(err)
	}
	return result
}
