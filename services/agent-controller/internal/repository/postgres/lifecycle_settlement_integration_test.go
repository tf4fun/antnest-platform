package postgres

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// Lifecycle component tests use a synthetic idle ACP, but the real publisher,
// configuration source, projection validation and acknowledgement persistence.
func testLifecycleExecution(repository *Repository) ports.LifecycleExecution {
	return application.NewExecutionPublisher(repository, mutationCredentialOpener{}, &lifecycleACPStub{})
}

func publishedAgentForTest(t *testing.T, repository *Repository, agent ports.AgentRecord) ports.ExecutionAgent {
	t.Helper()
	peer := &lifecycleACPStub{}
	publisher := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, peer)
	_, err := publisher.Publish(t.Context(), agent.OrganizationID)
	require.NoError(t, err)
	for _, published := range peer.snapshot.Agents {
		if published.AgentID == agent.AgentID {
			return published
		}
	}
	t.Fatalf("Agent %s missing from current projection", agent.AgentID)
	return ports.ExecutionAgent{}
}

type lifecycleACPStub struct {
	mu       sync.Mutex
	snapshot ports.ExecutionSnapshot
	outcome  string
}

func (client *lifecycleACPStub) ApplyExecutionSnapshot(_ context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.snapshot = snapshot
	return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
}

func (client *lifecycleACPStub) SettleAgent(_ context.Context, request ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	for _, agent := range client.snapshot.Agents {
		if agent.AgentID == request.AgentID && agent.OperationID != nil && *agent.OperationID == request.OperationID && !agent.AcceptingRuns && client.snapshot.OrganizationID == request.OrganizationID && client.snapshot.Revision >= request.MinimumRevision {
			outcome := client.outcome
			if outcome == "" {
				outcome = ports.ExecutionSettled
			}
			return ports.AgentSettlementResult{AppliedRevision: client.snapshot.Revision, Outcome: outcome}, nil
		}
	}
	return ports.AgentSettlementResult{}, fmt.Errorf("synthetic ACP did not receive the closed operation")
}

func TestLifecycleDrainConfirmationPersistsDeadlineAndStopBoundary(t *testing.T) {
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired} {
		t.Run(outcome, func(t *testing.T) {
			repository := providerTestRepository(t)
			base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
			now := time.Now().UTC().Truncate(time.Microsecond)
			deadline := now.Add(time.Minute)
			begin := disableBegin(base, "settle-disable", strings.Repeat("d", 64), now)
			begin.Operation.DrainDeadlineAt = &deadline
			_, _, err := repository.BeginAgentDisable(t.Context(), begin)
			require.NoError(t, err)
			stored, err := repository.GetLifecycleOperation(t.Context(), begin.Operation.RequestID)
			require.NoError(t, err)
			require.Equal(t, deadline, *stored.DrainDeadlineAt)
			input := ports.ConfirmLifecycleDrain{RequestID: stored.RequestID, Fingerprint: stored.RequestFingerprint, Kind: domain.OperationDisable, Outcome: outcome, Now: now.Add(time.Second)}
			operation, err := repository.ConfirmLifecycleDrain(t.Context(), input)
			require.NoError(t, err)
			require.Equal(t, domain.PhaseNetworkFence, operation.Phase)
			require.Equal(t, outcome, operation.SettlementOutcome)
			require.Equal(t, deadline, *operation.DrainDeadlineAt)
			replayed, err := repository.ConfirmLifecycleDrain(t.Context(), input)
			require.NoError(t, err)
			require.Equal(t, operation, replayed)
			input.Outcome = ports.ExecutionNotSettled
			_, err = repository.ConfirmLifecycleDrain(t.Context(), input)
			require.Error(t, err)
			input.Outcome = outcome
			input.Fingerprint = strings.Repeat("f", 64)
			_, err = repository.ConfirmLifecycleDrain(t.Context(), input)
			require.ErrorIs(t, err, ports.ErrRequestConflict)
		})
	}
}

func TestLifecycleDrainConfirmationFailureCannotAdvancePhase(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	now := time.Now().UTC().Truncate(time.Microsecond)
	deadline := now.Add(time.Minute)
	begin := disableBegin(base, "settle-failed-write", strings.Repeat("d", 64), now)
	begin.Operation.DrainDeadlineAt = &deadline
	_, _, err := repository.BeginAgentDisable(t.Context(), begin)
	require.NoError(t, err)
	_, err = repository.pool.Exec(t.Context(), `ALTER TABLE agent_controller.agent_lifecycle_operations ADD CONSTRAINT reject_test_settlement CHECK (settlement_outcome = '')`)
	require.NoError(t, err)
	_, err = repository.ConfirmLifecycleDrain(t.Context(), ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationDisable, Outcome: ports.ExecutionRuntimeBarrierRequired, Now: now})
	require.Error(t, err)
	operation, err := repository.GetLifecycleOperation(t.Context(), begin.Operation.RequestID)
	require.NoError(t, err)
	require.Equal(t, domain.PhaseDrain, operation.Phase)
	require.Empty(t, operation.SettlementOutcome)
	require.Equal(t, deadline, *operation.DrainDeadlineAt)
}

func TestLifecycleDrainConfirmationRejectsExpiredUnconfirmedOperation(t *testing.T) {
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired} {
		t.Run(outcome, func(t *testing.T) {
			repository := providerTestRepository(t)
			base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
			now := time.Now().UTC().Truncate(time.Microsecond)
			begin := disableBegin(base, "expired-confirmation", strings.Repeat("a", 64), now)
			_, _, err := repository.BeginAgentDisable(t.Context(), begin)
			require.NoError(t, err)
			_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agent_lifecycle_operations SET drain_deadline_at=clock_timestamp()-interval '1 second' WHERE request_id=$1`, begin.Operation.RequestID)
			require.NoError(t, err)
			_, err = repository.ConfirmLifecycleDrain(t.Context(), ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationDisable, Outcome: outcome, Now: now})
			require.ErrorIs(t, err, context.DeadlineExceeded)
			stored, err := repository.GetLifecycleOperation(t.Context(), begin.Operation.RequestID)
			require.NoError(t, err)
			require.Equal(t, domain.PhaseDrain, stored.Phase)
			require.Empty(t, stored.SettlementOutcome)
		})
	}
}

func TestLifecycleDrainConfirmationLockWaitCannotOutliveDeadline(t *testing.T) {
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired} {
		t.Run(outcome, func(t *testing.T) {
			repository := providerTestRepository(t)
			base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
			now := time.Now().UTC().Truncate(time.Microsecond)
			begin := disableBegin(base, "confirmation-lock", strings.Repeat("b", 64), now)
			_, _, err := repository.BeginAgentDisable(t.Context(), begin)
			require.NoError(t, err)
			lock, err := repository.pool.Begin(t.Context())
			require.NoError(t, err)
			defer func() { _ = lock.Rollback(t.Context()) }()
			require.NoError(t, lockLifecycleRequest(t.Context(), lock, begin.Operation.RequestID))
			deadline := time.Now().Add(100 * time.Millisecond)
			_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agent_lifecycle_operations SET drain_deadline_at=$2 WHERE request_id=$1`, begin.Operation.RequestID, deadline)
			require.NoError(t, err)
			ctx, cancel := context.WithDeadline(t.Context(), deadline)
			defer cancel()
			_, err = repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationDisable, Outcome: outcome, Now: now})
			require.ErrorIs(t, err, context.DeadlineExceeded)
			require.NoError(t, lock.Rollback(t.Context()))
			stored, err := repository.GetLifecycleOperation(t.Context(), begin.Operation.RequestID)
			require.NoError(t, err)
			require.Equal(t, domain.PhaseDrain, stored.Phase)
			require.Empty(t, stored.SettlementOutcome)
		})
	}
}

func TestLifecycleDrainConfirmationRejectsDetachedOperation(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	now := time.Now().UTC().Truncate(time.Microsecond)
	begin := disableBegin(base, "detached-confirmation", strings.Repeat("c", 64), now)
	_, _, err := repository.BeginAgentDisable(t.Context(), begin)
	require.NoError(t, err)
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET active_operation_request_id='' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	_, err = repository.ConfirmLifecycleDrain(t.Context(), ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationDisable, Outcome: ports.ExecutionSettled, Now: now})
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	stored, err := repository.GetLifecycleOperation(t.Context(), begin.Operation.RequestID)
	require.NoError(t, err)
	require.Equal(t, domain.PhaseDrain, stored.Phase)
	require.Empty(t, stored.SettlementOutcome)
}

func TestLifecycleDrainConfirmationReplaysCommittedOutcomeAfterDeadline(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	now := time.Now().UTC().Truncate(time.Microsecond)
	begin := disableBegin(base, "committed-confirmation", strings.Repeat("d", 64), now)
	_, _, err := repository.BeginAgentDisable(t.Context(), begin)
	require.NoError(t, err)
	input := ports.ConfirmLifecycleDrain{RequestID: begin.Operation.RequestID, Fingerprint: begin.Operation.RequestFingerprint, Kind: domain.OperationDisable, Outcome: ports.ExecutionSettled, Now: now}
	before, err := repository.ConfirmLifecycleDrain(t.Context(), input)
	require.NoError(t, err)
	_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agent_lifecycle_operations SET drain_deadline_at=clock_timestamp()-interval '1 second' WHERE request_id=$1`, begin.Operation.RequestID)
	require.NoError(t, err)
	after, err := repository.ConfirmLifecycleDrain(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, before.Phase, after.Phase)
	require.Equal(t, before.SettlementOutcome, after.SettlementOutcome)
	require.Equal(t, before.UpdatedAt, after.UpdatedAt)
}
