package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryAdmissionClockFollowsHeldLocks(t *testing.T) {
	for _, test := range []struct {
		name     string
		relation string
	}{
		{name: "policy_organization_advisory"},
		{name: "agent_row", relation: "agent_controller.agents"},
		{name: "event_journal_cursor_row", relation: "agent_controller.event_journal_cursor"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "clock-barrier-"+test.name, "original-clock-execution")
			worker := runtimeBarrierPolicySingleConnectionTestRepository(t, ctx)
			holder := openRuntimeBarrierPolicyTestRepository(t, ctx)
			const applicationName = "antnest-runtime-barrier-policy-cancel-test"
			var workerPID int32
			require.NoError(t, worker.pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&workerPID))
			require.Positive(t, workerPID)
			require.Zero(t, worker.pool.Stat().AcquiredConns())

			// The durable event must gain the recovery reason without adding it to
			// the caller's shared map. All other preparation inputs stay unchanged.
			delete(fixture.begin.RequestedEvent.Data, "rebuild_reason")
			originalData := make(map[string]any, len(fixture.begin.RequestedEvent.Data))
			for key, value := range fixture.begin.RequestedEvent.Data {
				originalData[key] = value
			}
			originalNow := fixture.begin.Now
			originalDrain := fixture.begin.Operation.DrainDeadlineAt
			require.NotNil(t, originalDrain)
			originalDeadline := *originalDrain
			originalDuration := originalDeadline.Sub(originalNow)
			require.Positive(t, originalDuration)
			originalOperationCreated := fixture.begin.Operation.CreatedAt
			originalOperationUpdated := fixture.begin.Operation.UpdatedAt
			originalSpecCreated := fixture.begin.TargetSpec.CreatedAt
			originalEventOccurred := fixture.begin.RequestedEvent.OccurredAt

			lock, err := holder.pool.Begin(ctx)
			require.NoError(t, err)
			mutationContext, cancelMutation := context.WithTimeout(ctx, 15*time.Second)
			type outcome struct {
				state    ports.AgentRebuildState
				replayed bool
				err      error
			}
			results := make(chan outcome, 1)
			returned := make(chan struct{})
			started, released := false, false
			releaseHolder := func() error {
				if released {
					return nil
				}
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				failure := lock.Rollback(cleanup)
				if failure == nil || errors.Is(failure, pgx.ErrTxClosed) {
					released = true
					return nil
				}
				return failure
			}
			waitReturned := func(budget time.Duration) bool {
				timer := time.NewTimer(budget)
				defer timer.Stop()
				select {
				case <-returned:
					return true
				case <-timer.C:
					return false
				}
			}
			t.Cleanup(func() {
				cancelMutation()
				// A failed assertion must release the blocker before joining the
				// actual repository call or closing either owned pool.
				if failure := releaseHolder(); failure != nil {
					t.Errorf("release the owned admission clock lock: %v", failure)
				}
				if !started || waitReturned(3*time.Second) {
					return
				}
				t.Error("the actual admission did not join after cancellation and holder release")
				cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				var terminated bool
				failure := fixture.store.pool.QueryRow(cleanup, `SELECT pg_terminate_backend(pid)
FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
					workerPID, applicationName).Scan(&terminated)
				cancel()
				if failure != nil && !errors.Is(failure, pgx.ErrNoRows) {
					t.Errorf("terminate the exact owned admission fixture backend: %v", failure)
				} else if failure == nil && !terminated {
					t.Error("the owned admission fixture backend could not be terminated")
				}
				if !waitReturned(5 * time.Second) {
					t.Error("the actual admission did not join after terminating its owned backend")
				}
			})

			switch test.name {
			case "policy_organization_advisory":
				_, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1,hashtext($2))`,
					runtimeBarrierPolicyOrganizationLockNamespace, fixture.base.Agent.OrganizationID)
			case "agent_row":
				var agentID string
				err = lock.QueryRow(ctx, `SELECT id FROM agent_controller.agents WHERE id=$1 FOR UPDATE`,
					fixture.base.Agent.AgentID).Scan(&agentID)
				if err == nil {
					require.Equal(t, fixture.base.Agent.AgentID, agentID)
				}
			case "event_journal_cursor_row":
				var sequence int64
				err = lock.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.event_journal_cursor
WHERE singleton FOR UPDATE`).Scan(&sequence)
			}
			require.NoError(t, err)
			var holderPID int32
			var holderTransactionID string
			require.NoError(t, lock.QueryRow(ctx, `SELECT pg_backend_pid(), pg_current_xact_id()::text`).Scan(
				&holderPID, &holderTransactionID,
			))
			require.NotEqual(t, workerPID, holderPID)
			require.NotEmpty(t, holderTransactionID)
			started = true
			go func() {
				defer close(returned)
				state, replayed, failure := worker.BeginAgentRebuild(mutationContext, fixture.begin)
				results <- outcome{state: state, replayed: replayed, err: failure}
			}()

			awaitRuntimeBarrierPolicyDatabaseCondition(t, ctx, "actual admission never waited on its owned lock", func(queryContext context.Context) (bool, error) {
				select {
				case <-returned:
					return false, errors.New("the actual admission returned before an observed lock wait")
				default:
				}
				var waiting bool
				var failure error
				if test.relation == "" {
					failure = fixture.store.pool.QueryRow(queryContext, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity activity JOIN pg_locks waiting_lock ON waiting_lock.pid=activity.pid
 WHERE activity.pid=$1 AND activity.datname=current_database()
   AND activity.application_name=$2 AND activity.state='active'
   AND activity.xact_start IS NOT NULL AND activity.wait_event_type='Lock'
   AND waiting_lock.locktype='advisory' AND NOT waiting_lock.granted
   AND waiting_lock.classid::bigint=$3
   AND waiting_lock.objid::bigint=(hashtext($4)::bigint & 4294967295)
   AND waiting_lock.objsubid=2 AND $5=ANY(pg_blocking_pids(activity.pid))
   AND EXISTS (SELECT 1 FROM pg_locks held_lock
     WHERE held_lock.pid=$5 AND held_lock.granted AND held_lock.locktype='advisory'
       AND held_lock.classid=waiting_lock.classid AND held_lock.objid=waiting_lock.objid
       AND held_lock.objsubid=waiting_lock.objsubid)
)`, workerPID, applicationName, runtimeBarrierPolicyOrganizationLockNamespace,
						fixture.base.Agent.OrganizationID, holderPID).Scan(&waiting)
				} else {
					// Row-lock contention waits on the holder's transaction ID. A
					// relation-only lock check would not prove this row was blocked.
					failure = fixture.store.pool.QueryRow(queryContext, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity activity JOIN pg_locks waiting_lock ON waiting_lock.pid=activity.pid
 WHERE activity.pid=$1 AND activity.datname=current_database()
   AND activity.application_name=$2 AND activity.state='active'
   AND activity.xact_start IS NOT NULL AND activity.wait_event_type='Lock'
   AND waiting_lock.locktype='transactionid' AND NOT waiting_lock.granted
   AND waiting_lock.transactionid::text=$3 AND $4=ANY(pg_blocking_pids(activity.pid))
   AND strpos(activity.query,$5)>0
   AND EXISTS (SELECT 1 FROM pg_locks held_lock WHERE held_lock.pid=$4
     AND held_lock.locktype='transactionid' AND held_lock.granted
     AND held_lock.transactionid=waiting_lock.transactionid)
   AND EXISTS (SELECT 1 FROM pg_locks relation_lock WHERE relation_lock.pid=activity.pid
     AND relation_lock.locktype='relation' AND relation_lock.granted
     AND relation_lock.relation=$5::regclass)
)`, workerPID, applicationName, holderTransactionID, holderPID, test.relation).Scan(&waiting)
				}
				return waiting, failure
			})

			// This receipt is read while the verified blocking transaction still
			// holds its lock. No elapsed sleep stands in for the database wait.
			var immediatelyBeforeRelease time.Time
			require.NoError(t, lock.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&immediatelyBeforeRelease))
			require.NoError(t, releaseHolder())
			require.True(t, waitReturned(5*time.Second), "actual admission must join after holder release")
			result := <-results
			require.NoError(t, result.err)
			require.False(t, result.replayed)
			receipt := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, result.state, receipt)
			require.False(t, receipt.AcceptedAt.Before(immediatelyBeforeRelease), "acceptance must follow all observed admission locks")

			var operationCreated, operationUpdated, drainDeadline, specCreated time.Time
			var eventOccurred, agentUpdated, cooldownAccepted, cooldownUntil time.Time
			var persistedReason string
			require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT
 operation.created_at, operation.updated_at, operation.drain_deadline_at,
 spec.created_at, event.occurred_at, agent.updated_at, event.data->>'rebuild_reason',
 cooldown.accepted_at, cooldown.cooldown_until
FROM agent_controller.agent_lifecycle_operations operation
JOIN agent_controller.agent_spec_revisions spec ON spec.id=operation.target_spec_revision_id
JOIN agent_controller.agent_events event ON event.event_id=$2 AND event.operation_request_id=operation.request_id
JOIN agent_controller.agents agent ON agent.id=operation.agent_id
JOIN agent_controller.runtime_barrier_recovery_cooldowns cooldown
 ON cooldown.agent_id=agent.id AND cooldown.request_id=operation.request_id
WHERE operation.request_id=$1`, fixture.begin.Operation.RequestID, fixture.begin.RequestedEvent.EventID).Scan(
				&operationCreated, &operationUpdated, &drainDeadline, &specCreated,
				&eventOccurred, &agentUpdated, &persistedReason, &cooldownAccepted, &cooldownUntil,
			))
			for name, actual := range map[string]time.Time{
				"operation.created_at": operationCreated, "operation.updated_at": operationUpdated,
				"spec.created_at": specCreated, "event.occurred_at": eventOccurred,
				"agent.updated_at": agentUpdated, "cooldown.accepted_at": cooldownAccepted,
				"returned.operation.created_at": result.state.Operation.CreatedAt,
				"returned.operation.updated_at": result.state.Operation.UpdatedAt,
				"returned.spec.created_at":      result.state.TargetSpec.CreatedAt,
				"returned.agent.updated_at":     result.state.Agent.UpdatedAt,
			} {
				require.True(t, actual.Equal(receipt.AcceptedAt), "%s must use the one accepted database clock", name)
			}
			require.Equal(t, ports.ExecutionRuntimeBarrierRequired, persistedReason)
			require.Equal(t, originalDuration, drainDeadline.Sub(receipt.AcceptedAt))
			require.NotNil(t, result.state.Operation.DrainDeadlineAt)
			require.True(t, result.state.Operation.DrainDeadlineAt.Equal(drainDeadline))
			require.True(t, cooldownUntil.Equal(receipt.CooldownUntil))
			require.True(t, cooldownUntil.Equal(receipt.AcceptedAt.Add(time.Duration(fixture.policy.CooldownMS)*time.Millisecond)))

			require.Equal(t, originalNow, fixture.begin.Now)
			require.Same(t, originalDrain, fixture.begin.Operation.DrainDeadlineAt)
			require.Equal(t, originalDeadline, *originalDrain)
			require.Equal(t, originalData, fixture.begin.RequestedEvent.Data)
			require.NotContains(t, fixture.begin.RequestedEvent.Data, "rebuild_reason")
			require.Equal(t, originalOperationCreated, fixture.begin.Operation.CreatedAt)
			require.Equal(t, originalOperationUpdated, fixture.begin.Operation.UpdatedAt)
			require.Equal(t, originalSpecCreated, fixture.begin.TargetSpec.CreatedAt)
			require.Equal(t, originalEventOccurred, fixture.begin.RequestedEvent.OccurredAt)
		})
	}
}
