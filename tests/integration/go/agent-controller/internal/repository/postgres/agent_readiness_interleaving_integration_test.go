package postgres

import (
	"context"
	"errors"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAgentReadinessBindingAndRepeatedACKInterleavings(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	before, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Greater(t, before.Revision, int64(1))
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-interleaved-binding", "interleaved-process", "http://interleaved-runtime:8091/mcp")
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))

	var publications atomic.Int64
	publish := func(ctx context.Context) error {
		changed, err := repo.PublishRuntimeBinding(ctx, input)
		if err == nil && changed {
			publications.Add(1)
		}
		return err
	}
	jobs := []func(context.Context) error{publish, publish}
	for _, revision := range []int64{before.Revision - 1, before.Revision, before.Revision, before.Revision - 1, before.Revision} {
		jobs = append(jobs, func(ctx context.Context) error {
			return repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
				OrganizationID: base.Agent.OrganizationID, AppliedRevision: revision,
			})
		})
	}
	agentReadinessRunInterleaved(t, ctx, 44, jobs)
	require.Equal(t, int64(1), publications.Load())
	boundState, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, boundState.Revision, "only binding publication advances the organization revision")
	require.Equal(t, before.Revision, boundState.AppliedRevision)
	require.NotEqual(t, input.Execution.Revision, boundState.Revision, "ACK thresholds are organization revisions, not Agent execution counters")
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	bound := agentReadinessEventsOfType(events, ports.EventRuntimeBound)
	require.Len(t, bound, 1)
	agentReadinessAssertProof(t, bound[0], input, boundState.Revision, 0)
	require.Empty(t, agentReadinessEventsOfType(events, ports.EventAgentReady), "all interleaved ACKs are below the newly published threshold")
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, boundState.Revision, fact.ReadyAfterRevision)
	require.Nil(t, fact.ReadyAt)
	require.Zero(t, fact.AppliedRevision)

	jobs = nil
	for _, revision := range []int64{boundState.Revision, before.Revision, boundState.Revision, before.Revision - 1, boundState.Revision} {
		jobs = append(jobs, func(ctx context.Context) error {
			return repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
				OrganizationID: base.Agent.OrganizationID, AppliedRevision: revision,
			})
		})
	}
	agentReadinessRunInterleaved(t, ctx, 45, jobs)
	events = agentReadinessEvents(t, ctx, repo, base.Agent)
	ready := agentReadinessEventsOfType(events, ports.EventAgentReady)
	require.Len(t, ready, 1)
	agentReadinessAssertProof(t, ready[0], input, boundState.Revision, boundState.Revision)
	require.Len(t, agentReadinessEventsOfType(events, ports.EventRuntimeBound), 1)
	fact = agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, boundState.Revision, fact.AppliedRevision)
	require.NotNil(t, fact.ReadyAt)
	covered, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, boundState.Revision, covered.Revision, "ordinary and duplicate ACKs must not republish configuration")
	require.Equal(t, boundState.Revision, covered.AppliedRevision)
}

// The seed fixes the submitted permutations; PostgreSQL decides the actual
// interleaving. Every call uses a bounded real context and is joined before any
// assertion or fixture cleanup can run.
func agentReadinessRunInterleaved(t *testing.T, parent context.Context, seed int64, jobs []func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	rand.New(rand.NewSource(seed)).Shuffle(len(jobs), func(left, right int) {
		jobs[left], jobs[right] = jobs[right], jobs[left]
	})
	start := make(chan struct{})
	results := make(chan error, len(jobs))
	var joined sync.WaitGroup
	for _, job := range jobs {
		joined.Add(1)
		go func() {
			defer joined.Done()
			<-start
			results <- job(ctx)
		}()
	}
	close(start)
	joined.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
}

func TestAgentReadinessACKRechecksCurrentEligibility(t *testing.T) {
	for _, change := range []string{"revoked", "desired-disabled", "active-rebuild", "runtime-unhealthy", "access-inactive"} {
		t.Run(change, func(t *testing.T) {
			ctx, repo, _ := controllerTestConnection(t)
			base, seed := seedConfiguredAgentForTest(t, ctx, repo, false)
			op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
			require.NoError(t, err)
			input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-eligibility-binding", "eligibility-process", "http://eligibility-runtime:8091/mcp")
			changed, err := repo.PublishRuntimeBinding(ctx, input)
			require.NoError(t, err)
			require.True(t, changed)
			current, err := repo.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
			require.NoError(t, err)
			require.True(t, current.Agent.ExecutionReady())
			switch change {
			case "revoked":
				cursor, err := repo.GetIdentityRevocationCursor(ctx)
				require.NoError(t, err)
				require.Greater(t, cursor+1, current.Agent.OwnerAuthorizationSequence)
				require.NoError(t, repo.ApplyIdentityRevocation(ctx, cursor, ports.PrincipalRevocation{
					Sequence: cursor + 1, UserID: current.Agent.OwnerUserID, OrganizationID: current.Agent.OrganizationID,
					Reason: "membership_deactivated", OccurredAt: time.Now().UTC(),
				}, ""))
			case "desired-disabled":
				// BeginDisable also attaches an active operation. Change only the
				// desired state here to isolate that eligibility fence from it.
				result, err := repo.pool.Exec(ctx, `UPDATE agent_controller.agents SET desired_state='disabled'
WHERE id=$1 AND desired_state='enabled' AND active_operation_request_id=''`, current.Agent.AgentID)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
			case "active-rebuild":
				begin := catalogRebuildInput(t, current, seed.Revision, seed.Model.Revision)
				state, replayed, err := repo.BeginAgentRebuild(ctx, begin)
				require.NoError(t, err)
				require.False(t, replayed)
				require.Equal(t, begin.Operation.RequestID, state.Agent.ActiveOperationRequestID)
				require.Equal(t, domain.OperationRunning, state.Operation.State)
			case "runtime-unhealthy":
				_, err := repo.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{
					ExpectedAggregateSequence: current.Agent.AggregateSequence,
					Inspection: ports.RuntimeInspection{
						AgentID: current.Agent.AgentID, RuntimeRevision: current.Agent.RuntimeRevision,
						RuntimeExecutionID: current.Agent.RuntimeExecutionID, MCPEndpoint: current.Agent.RuntimeMCPEndpoint,
						LifecycleState: "provisioned", Phase: "running", Health: "unhealthy",
						ObservedAt: input.Execution.PublishedAt.Add(time.Second),
					},
				})
				require.NoError(t, err)
			case "access-inactive":
				// No independent repository API deactivates only this binding.
				// Preserve Agent/source/watermarks so the access fence is tested.
				result, err := repo.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings SET active=false
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
					current.Agent.AgentID, current.Agent.OwnerUserID, current.Agent.AccessRevision)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
				unchanged, err := repo.GetAgent(ctx, current.Agent.AgentID)
				require.NoError(t, err)
				expected := current.Agent
				require.NotNil(t, expected.Readiness)
				evidence := *expected.Readiness
				evidence.Access.Active = false
				expected.Readiness = &evidence
				require.Equal(t, expected, unchanged, "only the newly joined access evidence changes")
			}
			beforeAgent, err := repo.GetAgent(ctx, base.Agent.AgentID)
			require.NoError(t, err)
			if change == "desired-disabled" {
				require.Equal(t, domain.DesiredDisabled, beforeAgent.DesiredState)
				require.Empty(t, beforeAgent.ActiveOperationRequestID)
			}
			if change == "runtime-unhealthy" {
				require.Equal(t, domain.RuntimeUnhealthy, beforeAgent.RuntimeState)
			}
			beforeEvents := agentReadinessEvents(t, ctx, repo, base.Agent)
			beforeFact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
			require.Nil(t, beforeFact.ReadyAt)
			publication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
			require.NoError(t, err)
			require.GreaterOrEqual(t, publication.Revision, beforeFact.ReadyAfterRevision)
			require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
				OrganizationID: base.Agent.OrganizationID, AppliedRevision: publication.Revision,
			}))
			require.Equal(t, beforeEvents, agentReadinessEvents(t, ctx, repo, base.Agent))
			require.Empty(t, agentReadinessEventsOfType(beforeEvents, ports.EventAgentReady))
			require.Equal(t, beforeFact, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID))
			afterAgent, err := repo.GetAgent(ctx, base.Agent.AgentID)
			require.NoError(t, err)
			require.NotNil(t, beforeAgent.Readiness)
			evidence := *beforeAgent.Readiness
			evidence.AppliedRevision = publication.Revision
			expectedAgent := beforeAgent
			expectedAgent.Readiness = &evidence
			require.Equal(t, expectedAgent, afterAgent, "ACK changes the joined watermark, never the closed Agent or its proof")
			require.Equal(t, "unavailable", afterAgent.CurrentReadiness())
			after, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, publication.Revision, after.Revision)
			require.Equal(t, publication.Revision, after.AppliedRevision)
		})
	}
}

func TestAgentReadinessACKEventInsertFailureRollsBackAllEffects(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-ack-rollback", "rollback-process", "http://rollback-runtime:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	publication, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	before := agentReadinessDatabaseState(t, ctx, repo, base.Agent)
	_, err = repo.pool.Exec(ctx, `CREATE FUNCTION agent_controller.agent_readiness_ack_test_fault()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.event_type='agent_ready' AND NEW.schema_version=2 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='injected readiness ACK event failure';
    END IF;
    RETURN NEW;
END;
$$`)
	require.NoError(t, err)
	restore := func() error {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, triggerErr := repo.pool.Exec(cleanup, `DROP TRIGGER IF EXISTS agent_readiness_ack_test_fault ON agent_controller.agent_events`)
		_, functionErr := repo.pool.Exec(cleanup, `DROP FUNCTION IF EXISTS agent_controller.agent_readiness_ack_test_fault()`)
		return errors.Join(triggerErr, functionErr)
	}
	t.Cleanup(func() {
		if err := restore(); err != nil {
			t.Errorf("remove readiness ACK insert fault: %v", err)
		}
	})
	_, err = repo.pool.Exec(ctx, `CREATE TRIGGER agent_readiness_ack_test_fault
BEFORE INSERT ON agent_controller.agent_events FOR EACH ROW
EXECUTE FUNCTION agent_controller.agent_readiness_ack_test_fault()`)
	require.NoError(t, err)
	ack := ports.ExecutionAcknowledgement{OrganizationID: base.Agent.OrganizationID, AppliedRevision: publication.Revision}
	err = repo.RecordExecutionApplied(ctx, ack)
	var fault *pgconn.PgError
	require.ErrorAs(t, err, &fault)
	require.Equal(t, "P0001", fault.Code)
	require.Equal(t, before, agentReadinessDatabaseState(t, ctx, repo, base.Agent), "ACK watermark, proof, Agent aggregate and journal must roll back together")
	require.NoError(t, restore())
	require.NoError(t, repo.RecordExecutionApplied(ctx, ack))
	events := agentReadinessEvents(t, ctx, repo, base.Agent)
	ready := agentReadinessEventsOfType(events, ports.EventAgentReady)
	require.Len(t, ready, 1)
	agentReadinessAssertProof(t, ready[0], input, publication.Revision, publication.Revision)
	fact := agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID)
	require.Equal(t, publication.Revision, fact.AppliedRevision)
	require.NotNil(t, fact.ReadyAt)
	after, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, publication.Revision, after.Revision)
	require.Equal(t, publication.Revision, after.AppliedRevision)
}

func TestAgentReadinessOtherOrganizationACKCannotCoverTargetBinding(t *testing.T) {
	ctx, repo, _ := controllerTestConnection(t)
	base, _ := seedConfiguredAgentForTest(t, ctx, repo, false)
	op, err := repo.GetLifecycleOperation(ctx, "request-create-for-rebuild")
	require.NoError(t, err)
	input := runtimeBindingInput(t, ctx, repo, base.Agent, op, "execution-org-scope", "org-scope-process", "http://org-scope-runtime:8091/mcp")
	changed, err := repo.PublishRuntimeBinding(ctx, input)
	require.NoError(t, err)
	require.True(t, changed)
	target, err := repo.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)

	// Publish an empty second organization through the real revision writer.
	// Its numeric ACK covers the target's threshold but has a different scope.
	const otherOrganization = "org-readiness-other"
	tx, err := repo.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	require.NoError(t, lockExecutionOrganization(ctx, tx, otherOrganization))
	for revision := int64(0); revision < target.Revision; revision++ {
		require.NoError(t, repo.advanceExecutionRevision(ctx, tx, otherOrganization))
	}
	require.NoError(t, tx.Commit(ctx))
	other, err := repo.GetExecutionSynchronization(ctx, otherOrganization)
	require.NoError(t, err)
	require.Equal(t, target.Revision, other.Revision)
	before := agentReadinessDatabaseState(t, ctx, repo, base.Agent)
	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: otherOrganization, AppliedRevision: other.Revision,
	}))
	coveredOther, err := repo.GetExecutionSynchronization(ctx, otherOrganization)
	require.NoError(t, err)
	require.Equal(t, other.Revision, coveredOther.AppliedRevision)
	require.Equal(t, before, agentReadinessDatabaseState(t, ctx, repo, base.Agent))
	require.Empty(t, agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady))
	require.Nil(t, agentReadinessFactForTest(t, ctx, repo, base.Agent.AgentID).ReadyAt)

	require.NoError(t, repo.RecordExecutionApplied(ctx, ports.ExecutionAcknowledgement{
		OrganizationID: base.Agent.OrganizationID, AppliedRevision: target.Revision,
	}))
	ready := agentReadinessEventsOfType(agentReadinessEvents(t, ctx, repo, base.Agent), ports.EventAgentReady)
	require.Len(t, ready, 1)
	agentReadinessAssertProof(t, ready[0], input, target.Revision, target.Revision)
}
