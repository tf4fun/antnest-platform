package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryProjectionPersistsEveryModeAndNullTombstone(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "projection-original-"+mode, "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, mode)
			before := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
			counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
			require.Zero(t, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
			require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store), "reading an absent observation revision must not write")

			initialNull := runtimeBarrierProjectionInput(t, ctx, fixture)
			initialNull.Fact.Barrier = nil
			require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, initialNull))
			require.EqualValues(t, 1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
			runtimeBarrierProjectionRows(t, ctx, fixture.store, fixture.base.Agent.AgentID, 1, 0, 0)
			projection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, fixture.base.Agent)
			require.NoError(t, err)
			require.Nil(t, projection, "a successful null read is persisted without inventing a barrier")

			input := runtimeBarrierProjectionInput(t, ctx, fixture)
			// These observational fields are not binding/source/owner CAS. In
			// particular, the barrier's original execution is not a health ID.
			input.ExpectedAgent.AggregateSequence += 99
			input.ExpectedAgent.UpdatedAt = input.ExpectedAgent.UpdatedAt.Add(time.Hour)
			observedAt := time.Now().UTC()
			input.ExpectedAgent.RuntimeObservedAt = &observedAt
			input.ExpectedAgent.RuntimeExecutionID = "newer-health-execution"
			originalInput := cloneRuntimeBarrierProjectionInput(input)
			require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, input))
			require.Equal(t, originalInput, input, "the caller's observation and Agent snapshot are immutable")
			require.EqualValues(t, 2, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
			current, err := fixture.store.GetAgent(ctx, fixture.base.Agent.AgentID)
			require.NoError(t, err)
			projection, err = fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, current)
			require.NoError(t, err)
			assertRuntimeBarrierProjection(t, fixture, projection, nil)
			if mode == "notify" {
				require.Equal(t, fixture.base.Agent.AggregateSequence+1, current.AggregateSequence)
				require.False(t, current.UpdatedAt.Before(fixture.base.Agent.UpdatedAt))
			} else {
				require.Equal(t, fixture.base.Agent, current, "manual/auto observation alone does not append an Agent notification")
			}
			notifications := int64(0)
			if mode == "notify" {
				notifications = 1
			}
			runtimeBarrierProjectionRows(t, ctx, fixture.store, current.AgentID, 1, notifications, notifications)
			require.Equal(t, counts, readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, current.AgentID), "observation and notification do not consume a recovery operation")
			require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, input), "same fact/source/policy is a no-op even with its old observation stamp")
			require.EqualValues(t, 2, runtimeBarrierProjectionRevision(t, ctx, fixture.store, current))
			afterReplay, err := fixture.store.GetAgent(ctx, current.AgentID)
			require.NoError(t, err)
			require.Equal(t, current, afterReplay, "duplicate notification does not advance Agent watermarks")
			runtimeBarrierProjectionRows(t, ctx, fixture.store, current.AgentID, 1, notifications, notifications)

			beforeOldNull := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
			require.ErrorIs(t, fixture.store.RecordRuntimeBarrierObservation(ctx, initialNull), ports.ErrConcurrentChange,
				"the old successful null cannot erase a subsequently observed barrier")
			require.Equal(t, beforeOldNull, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store))
			fixture.store.Close()
			reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
			projection, err = reopened.GetRuntimeBarrierRecoveryProjection(ctx, current)
			require.NoError(t, err)
			assertRuntimeBarrierProjection(t, fixture, projection, nil)
			require.EqualValues(t, 2, runtimeBarrierProjectionRevision(t, ctx, reopened, current))

			clear := cloneRuntimeBarrierProjectionInput(input)
			clear.ExpectedAgent = current
			clear.ExpectedObservationRevision = runtimeBarrierProjectionRevision(t, ctx, reopened, current)
			clear.Fact.Barrier = nil
			require.NoError(t, reopened.RecordRuntimeBarrierObservation(ctx, clear))
			require.EqualValues(t, 3, runtimeBarrierProjectionRevision(t, ctx, reopened, current))
			projection, err = reopened.GetRuntimeBarrierRecoveryProjection(ctx, current)
			require.NoError(t, err)
			require.Nil(t, projection)
			runtimeBarrierProjectionRows(t, ctx, reopened, current.AgentID, 1, notifications, notifications)
			reopened.Close()
			again := openRuntimeBarrierPolicyTestRepository(t, ctx)
			projection, err = again.GetRuntimeBarrierRecoveryProjection(ctx, current)
			require.NoError(t, err)
			require.Nil(t, projection, "the null tombstone survives process-local pool replacement")
			require.EqualValues(t, 3, runtimeBarrierProjectionRevision(t, ctx, again, current))
			runtimeBarrierProjectionRows(t, ctx, again, current.AgentID, 1, notifications, notifications)
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionNotifyOpaqueConcurrentListWatchAndReopen(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "barrier-\x00-原/e\u0301-🧪", "execution-\x00-原/e\u0301-🧪")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	service, notifier := runtimeBarrierProjectionEvents(t, ctx, fixture.store)
	hint, err := notifier.SubscribeAgentEvents()
	require.NoError(t, err)
	before := runtimeBarrierProjectionLastSequence(t, ctx, fixture.store)
	input := runtimeBarrierProjectionInput(t, ctx, fixture)
	originalInput := cloneRuntimeBarrierProjectionInput(input)
	caller, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, 2)
	joined := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(2)
	for _, store := range []*Repository{fixture.store, other} {
		go func(store *Repository) {
			defer workers.Done()
			<-start
			results <- store.RecordRuntimeBarrierObservation(caller, input)
		}(store)
	}
	go func() { workers.Wait(); close(joined) }()
	// Cancellation is followed by actual joins before notifier/pool owners close.
	defer func() { cancel(); <-joined }()
	close(start)
	select {
	case <-joined:
	case <-caller.Done():
		t.Fatal("concurrent notification transactions did not finish within their database budget")
	}
	for range 2 {
		require.NoError(t, <-results, "same snapshot and fact may both succeed while notification is deduplicated")
	}
	require.Equal(t, originalInput, input)
	awaitAgentNotification(t, ctx, hint)
	runtimeBarrierProjectionRows(t, ctx, fixture.store, fixture.base.Agent.AgentID, 1, 1, 1)
	require.EqualValues(t, 1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
	current, err := fixture.store.GetAgent(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, fixture.base.Agent.AggregateSequence+1, current.AggregateSequence)
	page, err := service.ListAgentEvents(ctx, application.ListAgentEventsInput{
		OrganizationID: current.OrganizationID, AgentID: current.AgentID, AfterSequence: before, Limit: 10,
	})
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	assertRuntimeBarrierProjectionNotification(t, fixture, page.Events[0])
	require.Equal(t, before+1, page.NextSequence)
	global, err := service.ListGlobalEvents(ctx, application.ListEventsInput{
		OrganizationID: current.OrganizationID, AfterSequence: before, Limit: 10,
	})
	require.NoError(t, err)
	require.Equal(t, page, global)
	stopWatch := errors.New("owned notification replay observed")
	var watched []application.AgentEventView
	err = service.WatchAgentEvents(ctx, current.OrganizationID, current.AgentID, before, func(event application.AgentEventView) error {
		watched = append(watched, event)
		return stopWatch
	})
	require.ErrorIs(t, err, stopWatch)
	require.Equal(t, page.Events, watched, "real Watch hydrates exactly the same opaque event as List")
	notificationID, err := ports.RuntimeBarrierNotificationID(current.OrganizationID, current.AgentID, input.Fact.Barrier.BarrierID)
	require.NoError(t, err)
	var rawBarrier, rawData []byte
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT barrier_id FROM agent_controller.runtime_barrier_recovery_notifications WHERE event_id=$1`, notificationID).Scan(&rawBarrier))
	require.Equal(t, []byte(input.Fact.Barrier.BarrierID), rawBarrier)
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT data FROM agent_controller.agent_events WHERE event_id=$1`, notificationID).Scan(&rawData))
	var storedData map[string]any
	require.NoError(t, json.Unmarshal(rawData, &storedData))
	require.Len(t, storedData, 4)
	require.NotContains(t, storedData, "barrier_id", "NUL-bearing identity belongs in BYTEA, not event JSONB")
	require.Equal(t, map[string]any{
		"organization_id": current.OrganizationID, "runtime_revision": current.RuntimeRevision,
		"reason": ports.ExecutionRuntimeBarrierRequired, "policy_revision": float64(fixture.policy.Revision),
	}, storedData)
	notifier.Close()
	other.Close()
	fixture.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	restarted, _ := runtimeBarrierProjectionEvents(t, ctx, reopened)
	pageAfterRestart, err := restarted.ListAgentEvents(ctx, application.ListAgentEventsInput{
		OrganizationID: current.OrganizationID, AgentID: current.AgentID, AfterSequence: before, Limit: 10,
	})
	require.NoError(t, err)
	require.Equal(t, page, pageAfterRestart)
	projection, err := reopened.GetRuntimeBarrierRecoveryProjection(ctx, current)
	require.NoError(t, err)
	assertRuntimeBarrierProjection(t, fixture, projection, nil)
	beforeReplay := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened)
	require.NoError(t, reopened.RecordRuntimeBarrierObservation(ctx, input))
	require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened), "same original notification is a durable no-op after reopening")
}

func TestRuntimeBarrierRecoveryProjectionNotificationDoesNotConsumeManualAdmission(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "notify-then-manual-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, runtimeBarrierProjectionInput(t, ctx, fixture)))
	base, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, fixture.base.Agent.AggregateSequence+1, base.Agent.AggregateSequence)
	require.Empty(t, base.Agent.ActiveOperationRequestID)
	fixture = runtimeBarrierAdmissionForAgent(t, fixture.store, base, fixture.seed, fixture.policy,
		fixture.begin.Recovery.Fact.Barrier.BarrierID, fixture.begin.Recovery.Fact.Barrier.RuntimeExecutionID)
	fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
	counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, base.Agent.AgentID)
	require.Zero(t, counts.operations)
	require.Zero(t, counts.receipts)
	require.Zero(t, counts.cooldowns)
	require.Zero(t, counts.starts)
	state, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.False(t, replayed)
	assertOneRuntimeBarrierAdmission(t, ctx, fixture, counts)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	require.True(t, original.Manual)
	require.Equal(t, "notify", original.Policy.Mode)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, state, original)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)
	runtimeBarrierProjectionRows(t, ctx, fixture.store, base.Agent.AgentID, 1, 1, 1)
	projection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, state.Agent)
	require.NoError(t, err)
	assertRuntimeBarrierProjection(t, fixture, projection, &original.CooldownUntil)
	beforeReplay := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	replayedState, replayed, err := fixture.store.BeginAgentRebuild(ctx, fixture.begin)
	require.NoError(t, err)
	require.True(t, replayed)
	require.Equal(t, state.Operation, replayedState.Operation)
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin))
	require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store))
}

func TestRuntimeBarrierRecoveryProjectionRejectsStaleBindingSourceOwnerAndPolicy(t *testing.T) {
	for _, scenario := range []struct {
		name            string
		change          func(*testing.T, context.Context, runtimeBarrierAdmissionFixture, *ports.RecordRuntimeBarrierObservation)
		staleProjection bool
	}{
		{"access-binding", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.AccessRevision = "access-superseded"
		}, true},
		{"owner", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.OwnerUserID = "another-owner"
		}, true},
		{"owner-watermark", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.OwnerAuthorizationSequence++
		}, true},
		{"revocation-watermark", func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, _ *ports.RecordRuntimeBarrierObservation) {
			changed, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.agents SET identity_revocation_sequence=identity_revocation_sequence+1 WHERE id=$1`, fixture.base.Agent.AgentID)
			require.NoError(t, err)
			require.EqualValues(t, 1, changed.RowsAffected())
		}, true},
		{"runtime", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.RuntimeRevision = "rtv_other_source"
			input.Fact.RuntimeRevision = input.ExpectedAgent.RuntimeRevision
		}, true},
		{"configured-spec", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.AgentSpecRevisionID = "agentspec_other_source"
		}, true},
		{"execution-binding", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.ExecutionRevisionID = "execution_other_source"
		}, true},
		{"organization", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedAgent.OrganizationID = "foreign-org"
			input.Fact.OrganizationID = input.ExpectedAgent.OrganizationID
		}, true},
		{"policy-CAS", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedPolicyRevision++
		}, false},
		{"observation-CAS", func(_ *testing.T, _ context.Context, _ runtimeBarrierAdmissionFixture, input *ports.RecordRuntimeBarrierObservation) {
			input.ExpectedObservationRevision--
		}, false},
		{"actual-inactive-binding", func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, _ *ports.RecordRuntimeBarrierObservation) {
			// Fixture-only change to exactly the current binding; Agent fields stay
			// unchanged so this is not an unrelated aggregate-CAS rejection.
			changed, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings
SET active=false,updated_at=clock_timestamp() WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
				fixture.base.Agent.AgentID, fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision)
			require.NoError(t, err)
			require.EqualValues(t, 1, changed.RowsAffected())
			current, err := fixture.store.GetAgent(ctx, fixture.base.Agent.AgentID)
			require.NoError(t, err)
			require.Equal(t, fixture.base.Agent, current)
		}, true},
		{"actual-policy-change", func(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, _ *ports.RecordRuntimeBarrierObservation) {
			_, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
				fixture.base.Agent.OrganizationID, "projection-policy-new-revision", fixture.policy.Revision, "notify", 60000))
			require.NoError(t, err)
		}, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "retained-projection-barrier", "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "manual")
			require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, runtimeBarrierProjectionInput(t, ctx, fixture)))
			input := runtimeBarrierProjectionInput(t, ctx, fixture)
			input.Fact.Barrier.BarrierID = "different-new-observation"
			scenario.change(t, ctx, fixture, &input)
			before := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
			frozen := cloneRuntimeBarrierProjectionInput(input)

			err := fixture.store.RecordRuntimeBarrierObservation(ctx, input)

			require.ErrorIs(t, err, ports.ErrConcurrentChange)
			require.Equal(t, frozen, input)
			require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store), "stale observation cannot clear or replace the known reason or append effects")
			if scenario.staleProjection {
				projection, err := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, input.ExpectedAgent)
				require.NoError(t, err)
				require.Nil(t, projection, "a stale or inaccessible source must not expose another binding's recovery projection")
			}
		})
	}
}

func TestRuntimeBarrierRecoveryProjectionEventFailureRollsBackAllObservationEffects(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "rollback-notification-barrier", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
	before := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	input := runtimeBarrierProjectionInput(t, ctx, fixture)
	restore := installRuntimeBarrierAdmissionFault(t, ctx, fixture.store, "agent_events")

	err := fixture.store.RecordRuntimeBarrierObservation(ctx, input)

	var failure *pgconn.PgError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "P0001", failure.Code, "the real journal INSERT must reach the owned PostgreSQL trigger")
	require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store))
	require.Zero(t, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
	runtimeBarrierProjectionRows(t, ctx, fixture.store, fixture.base.Agent.AgentID, 0, 0, 0)
	projection, readErr := fixture.store.GetRuntimeBarrierRecoveryProjection(ctx, fixture.base.Agent)
	require.NoError(t, readErr)
	require.Nil(t, projection)
	require.NoError(t, restore())
	require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, input))
	runtimeBarrierProjectionRows(t, ctx, fixture.store, fixture.base.Agent.AgentID, 1, 1, 1)
	require.EqualValues(t, 1, runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent))
}

func TestRuntimeBarrierRecoveryProjectionRejectsCorruptNotificationBeforeReturningAnyEvent(t *testing.T) {
	for _, corruption := range []string{"missing-extension", "changed-opaque-tuple"} {
		t.Run(corruption, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "notification-\x00-original-🧪", "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "notify")
			require.NoError(t, fixture.store.RecordRuntimeBarrierObservation(ctx, runtimeBarrierProjectionInput(t, ctx, fixture)))
			service, _ := runtimeBarrierProjectionEvents(t, ctx, fixture.store)
			notificationID, err := ports.RuntimeBarrierNotificationID(fixture.base.Agent.OrganizationID,
				fixture.base.Agent.AgentID, fixture.begin.Recovery.Fact.Barrier.BarrierID)
			require.NoError(t, err)
			valid, err := service.ListGlobalEvents(ctx, application.ListEventsInput{OrganizationID: fixture.base.Agent.OrganizationID, Limit: 100})
			require.NoError(t, err)
			require.Greater(t, len(valid.Events), 1, "the malformed notification shares a page with earlier valid historical events")
			restore := runtimeBarrierProjectionNotificationRestore(t, ctx, fixture.store, notificationID)
			var changed int64
			if corruption == "missing-extension" {
				result, err := fixture.store.pool.Exec(ctx, `DELETE FROM agent_controller.runtime_barrier_recovery_notifications WHERE event_id=$1`, notificationID)
				require.NoError(t, err)
				changed = result.RowsAffected()
			} else {
				result, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.runtime_barrier_recovery_notifications SET barrier_id=$2 WHERE event_id=$1`,
					notificationID, []byte("different-valid-opaque-\x00-🧪"))
				require.NoError(t, err)
				changed = result.RowsAffected()
			}
			require.EqualValues(t, 1, changed)
			var rawEvents int
			require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events WHERE event_id=$1`, notificationID).Scan(&rawEvents))
			require.Equal(t, 1, rawEvents, "corruption affects only the typed extension; the original journal entry remains")
			global, err := service.ListGlobalEvents(ctx, application.ListEventsInput{OrganizationID: fixture.base.Agent.OrganizationID, Limit: 100})
			require.Error(t, err)
			require.Equal(t, application.AgentEventPage{}, global)
			agentPage, err := service.ListAgentEvents(ctx, application.ListAgentEventsInput{
				OrganizationID: fixture.base.Agent.OrganizationID, AgentID: fixture.base.Agent.AgentID, Limit: 100,
			})
			require.Error(t, err)
			require.Equal(t, application.AgentEventPage{}, agentPage)
			emitted := 0
			err = service.WatchAgentEvents(ctx, fixture.base.Agent.OrganizationID, fixture.base.Agent.AgentID, 0,
				func(application.AgentEventView) error { emitted++; return errors.New("must not emit a partial page") })
			require.Error(t, err)
			require.Zero(t, emitted)
			require.NoError(t, restore())
			recovered, err := service.ListGlobalEvents(ctx, application.ListEventsInput{OrganizationID: fixture.base.Agent.OrganizationID, Limit: 100})
			require.NoError(t, err)
			require.Equal(t, valid, recovered)
		})
	}
}

func runtimeBarrierProjectionInput(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) ports.RecordRuntimeBarrierObservation {
	t.Helper()
	input := ports.RecordRuntimeBarrierObservation{
		Fact: fixture.begin.Recovery.Fact, ExpectedAgent: fixture.base.Agent,
		ExpectedPolicyRevision:      fixture.policy.Revision,
		ExpectedObservationRevision: runtimeBarrierProjectionRevision(t, ctx, fixture.store, fixture.base.Agent),
	}
	return cloneRuntimeBarrierProjectionInput(input)
}

func cloneRuntimeBarrierProjectionInput(input ports.RecordRuntimeBarrierObservation) ports.RecordRuntimeBarrierObservation {
	if input.Fact.Barrier != nil {
		barrier := *input.Fact.Barrier
		input.Fact.Barrier = &barrier
	}
	if input.ExpectedAgent.RuntimeObservedAt != nil {
		observedAt := *input.ExpectedAgent.RuntimeObservedAt
		input.ExpectedAgent.RuntimeObservedAt = &observedAt
	}
	return input
}

func runtimeBarrierProjectionRevision(t *testing.T, ctx context.Context, store *Repository, agent ports.AgentRecord) int64 {
	t.Helper()
	revision, err := store.GetRuntimeBarrierObservationRevision(ctx, agent.OrganizationID, agent.AgentID)
	require.NoError(t, err)
	return revision
}

func assertRuntimeBarrierProjection(t *testing.T, fixture runtimeBarrierAdmissionFixture, projection *ports.RuntimeBarrierRecoveryProjection, cooldown *time.Time) {
	t.Helper()
	if cooldown != nil {
		utc := cooldown.UTC()
		cooldown = &utc
	}
	fact := fixture.begin.Recovery.Fact
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	notificationID, err := ports.RuntimeBarrierNotificationID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	require.NotNil(t, projection)
	expected := ports.RuntimeBarrierRecoveryProjection{
		BarrierID: fact.Barrier.BarrierID, Reason: ports.ExecutionRuntimeBarrierRequired, RuntimeRevision: fact.RuntimeRevision,
		PolicyRevision: fixture.policy.Revision, Mode: fixture.policy.Mode, CooldownMS: fixture.policy.CooldownMS,
		RebuildRequestID: requestID, NotificationID: notificationID, CooldownUntil: cooldown,
	}
	require.Equal(t, expected, *projection)
	payload, err := json.Marshal(projection)
	require.NoError(t, err)
	require.NotContains(t, string(payload), fact.Barrier.RuntimeExecutionID)
	require.NotContains(t, string(payload), fixture.base.Agent.RuntimeMCPEndpoint)
}

func runtimeBarrierProjectionRows(t *testing.T, ctx context.Context, store *Repository, agentID string, observations, notifications, events int64) {
	t.Helper()
	var observedCount, notificationCount, eventCount int64
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_observations WHERE agent_id=$1),
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_notifications WHERE agent_id=$1),
(SELECT count(*) FROM agent_controller.agent_events WHERE agent_id=$1 AND event_type=$2)`,
		agentID, ports.EventAgentRuntimeBarrierRequired).Scan(&observedCount, &notificationCount, &eventCount))
	require.Equal(t, observations, observedCount)
	require.Equal(t, notifications, notificationCount)
	require.Equal(t, events, eventCount)
}

func runtimeBarrierProjectionLastSequence(t *testing.T, ctx context.Context, store *Repository) int64 {
	t.Helper()
	var sequence int64
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.event_journal_cursor WHERE singleton`).Scan(&sequence))
	return sequence
}

func runtimeBarrierProjectionEvents(t *testing.T, ctx context.Context, store *Repository) (*application.EventService, *EventNotifier) {
	t.Helper()
	notifier, err := OpenEventNotifier(ctx, os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL"))
	require.NoError(t, err)
	t.Cleanup(notifier.Close)
	return application.NewEventService(store, notifier, store), notifier
}

func assertRuntimeBarrierProjectionNotification(t *testing.T, fixture runtimeBarrierAdmissionFixture, event application.AgentEventView) {
	t.Helper()
	fact := fixture.begin.Recovery.Fact
	id, err := ports.RuntimeBarrierNotificationID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	require.Equal(t, id, event.EventID)
	require.Equal(t, fact.AgentID, event.AgentID)
	require.Equal(t, ports.EventAgentRuntimeBarrierRequired, event.EventType)
	require.Equal(t, 1, event.SchemaVersion)
	require.Empty(t, event.OperationRequestID)
	require.False(t, event.OccurredAt.IsZero())
	require.Len(t, event.Data, 5)
	require.Equal(t, map[string]any{
		"organization_id": fact.OrganizationID, "barrier_id": fact.Barrier.BarrierID,
		"runtime_revision": fact.RuntimeRevision, "reason": ports.ExecutionRuntimeBarrierRequired,
		"policy_revision": float64(fixture.policy.Revision),
	}, event.Data)
}

func runtimeBarrierProjectionNotificationRestore(t *testing.T, ctx context.Context, store *Repository, eventID string) func() error {
	t.Helper()
	var original string
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT to_jsonb(notification)::text
FROM agent_controller.runtime_barrier_recovery_notifications notification WHERE event_id=$1`, eventID).Scan(&original))
	restore := func() (result error) {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, err := store.pool.Begin(cleanup)
		if err != nil {
			return err
		}
		defer func() {
			if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
				result = errors.Join(result, err)
			}
		}()
		if _, err := tx.Exec(cleanup, `DELETE FROM agent_controller.runtime_barrier_recovery_notifications WHERE event_id=$1`, eventID); err != nil {
			return err
		}
		if _, err := tx.Exec(cleanup, `INSERT INTO agent_controller.runtime_barrier_recovery_notifications
SELECT (jsonb_populate_record(NULL::agent_controller.runtime_barrier_recovery_notifications,$1::jsonb)).*`, original); err != nil {
			return err
		}
		return tx.Commit(cleanup)
	}
	t.Cleanup(func() {
		if err := restore(); err != nil {
			t.Errorf("restore owned notification extension: %v", err)
		}
	})
	return restore
}
