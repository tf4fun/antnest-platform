package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type lifecycleExecutionStub struct {
	settle func(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error)
}

func testExecutionForStore(store ports.LifecycleStore) ports.LifecycleExecution {
	return store.(ports.LifecycleExecution)
}

func testDrainDeadline(deadline time.Time) *time.Time { return &deadline }

func (*lifecycleStoreStub) CloseAndSettle(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return ports.AgentSettlementResult{}, errors.New("unexpected ACP settlement")
}

func fakeSettlement(blocked bool) ports.AgentSettlementResult {
	outcome := ports.ExecutionSettled
	if blocked {
		outcome = ports.ExecutionNotSettled
	}
	return ports.AgentSettlementResult{AppliedRevision: 1, Outcome: outcome}
}

func (store *rebuildLifecycleStoreStub) CloseAndSettle(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return fakeSettlement(store.drainBlocked), nil
}

func (store *disableLifecycleStoreStub) CloseAndSettle(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return fakeSettlement(store.drainBlocked), nil
}

func (store *deleteLifecycleStoreStub) CloseAndSettle(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return fakeSettlement(store.drainBlocked), nil
}

func confirmTestDrain(operation ports.LifecycleOperationRecord, input ports.ConfirmLifecycleDrain) ports.LifecycleOperationRecord {
	operation.Phase = domain.PhaseNetworkFence
	operation.ChildRequestID = domain.ChildRequestID(input.RequestID, domain.PhaseNetworkFence)
	operation.SettlementOutcome = input.Outcome
	operation.UpdatedAt = input.Now
	return operation
}

func (store *rebuildLifecycleStoreStub) ConfirmLifecycleDrain(_ context.Context, input ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	store.state.Operation = confirmTestDrain(store.state.Operation, input)
	return store.state.Operation, nil
}

func (store *disableLifecycleStoreStub) ConfirmLifecycleDrain(_ context.Context, input ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	store.state.Operation = confirmTestDrain(store.state.Operation, input)
	return store.state.Operation, nil
}

func (store *deleteLifecycleStoreStub) ConfirmLifecycleDrain(_ context.Context, input ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	store.state.Operation = confirmTestDrain(store.state.Operation, input)
	return store.state.Operation, nil
}

func (stub lifecycleExecutionStub) CloseAndSettle(ctx context.Context, request ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	return stub.settle(ctx, request)
}

func TestLifecycleSettlementUsesPersistedDeadlineAndAgentBoundary(t *testing.T) {
	now := time.Now().UTC()
	deadline := now.Add(time.Minute)
	agent := ports.AgentRecord{AgentID: "agent-1", OrganizationID: "org-1"}
	operation := ports.LifecycleOperationRecord{RequestID: "operation-1", AgentID: agent.AgentID, DrainDeadlineAt: &deadline}
	for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired, ports.ExecutionNotSettled} {
		t.Run(outcome, func(t *testing.T) {
			service := &LifecycleService{clock: fixedClock{now: now}, drainTimeout: time.Hour, execution: lifecycleExecutionStub{settle: func(_ context.Context, request ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
				require.Equal(t, ports.LifecycleSettlementRequest{OrganizationID: agent.OrganizationID, AgentID: agent.AgentID, OperationID: operation.RequestID, Mode: "wait", DeadlineAt: deadline}, request)
				return ports.AgentSettlementResult{AppliedRevision: 3, Outcome: outcome}, nil
			}}}
			ready, err := service.settleLifecycleExecution(t.Context(), agent, operation)
			require.NoError(t, err)
			require.Equal(t, outcome, ready)
		})
	}
}

func TestLifecycleSettlementSelectsModeFromManagementIntent(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		kind       domain.OperationKind
		revocation int64
		want       string
	}{
		{"rebuild", domain.OperationRebuild, 0, "wait"},
		{"disable", domain.OperationDisable, 0, "wait"},
		{"delete", domain.OperationDelete, 0, "cancel"},
		{"offboarding", domain.OperationDisable, 5, "cancel"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			now := time.Now().UTC()
			service := &LifecycleService{clock: fixedClock{now: now}, execution: lifecycleExecutionStub{settle: func(_ context.Context, request ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
				require.Equal(t, scenario.want, request.Mode)
				return ports.AgentSettlementResult{Outcome: ports.ExecutionSettled}, nil
			}}}
			_, err := service.settleLifecycleExecution(t.Context(), ports.AgentRecord{AgentID: "agent-1", OrganizationID: "org-1"}, ports.LifecycleOperationRecord{RequestID: "operation-1", Kind: scenario.kind, OwnerRevocationSequence: scenario.revocation, DrainDeadlineAt: testDrainDeadline(now.Add(time.Minute))})
			require.NoError(t, err)
		})
	}
}

func TestLifecycleSettlementNeverTreatsErrorsOrMissingEvidenceAsIdle(t *testing.T) {
	now := time.Now().UTC()
	deadline := now.Add(time.Minute)
	agent := ports.AgentRecord{AgentID: "agent-1", OrganizationID: "org-1"}
	for _, scenario := range []string{"missing-client", "missing-deadline", "expired", "transport", "invalid-result", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			operation := ports.LifecycleOperationRecord{RequestID: "operation-1", AgentID: agent.AgentID, DrainDeadlineAt: &deadline}
			service := &LifecycleService{clock: fixedClock{now: now}}
			if scenario == "missing-deadline" {
				operation.DrainDeadlineAt = nil
			}
			if scenario == "expired" {
				operation.DrainDeadlineAt = &now
			}
			if scenario == "transport" || scenario == "invalid-result" {
				service.execution = lifecycleExecutionStub{settle: func(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
					if scenario == "transport" {
						return ports.AgentSettlementResult{}, errors.New("synthetic RPC failure")
					}
					return ports.AgentSettlementResult{Outcome: "unknown"}, nil
				}}
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			ready, err := service.settleLifecycleExecution(ctx, agent, operation)
			require.Error(t, err)
			require.Empty(t, ready)
			if scenario == "expired" {
				require.ErrorIs(t, err, context.DeadlineExceeded)
			}
			if scenario == "cancelled" {
				require.ErrorIs(t, err, context.Canceled)
			}
		})
	}
}

type lifecycleDrainStoreStub struct {
	ports.LifecycleStore
	advances int
	confirm  func(context.Context, ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error)
}

func (store *lifecycleDrainStoreStub) ConfirmLifecycleDrain(ctx context.Context, input ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	if store.confirm != nil {
		return store.confirm(ctx, input)
	}
	store.advances++
	return ports.LifecycleOperationRecord{Phase: domain.PhaseNetworkFence, SettlementOutcome: input.Outcome}, nil
}

func TestLifecycleConfirmationSharesOriginalDeadline(t *testing.T) {
	now := time.Now().UTC()
	deadline := now.Add(time.Minute)
	store := &lifecycleDrainStoreStub{confirm: func(ctx context.Context, _ ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
		actual, ok := ctx.Deadline()
		require.True(t, ok)
		require.Equal(t, deadline, actual)
		return ports.LifecycleOperationRecord{}, nil
	}}
	service := &LifecycleService{store: store, clock: fixedClock{now: now}}
	_, err := service.confirmLifecycleDrain(t.Context(), ports.LifecycleOperationRecord{DrainDeadlineAt: &deadline}, ports.ExecutionSettled)
	require.NoError(t, err)
	service.clock = fixedClock{now: deadline}
	_, err = service.confirmLifecycleDrain(t.Context(), ports.LifecycleOperationRecord{DrainDeadlineAt: &deadline}, ports.ExecutionSettled)
	require.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestLifecycleDrainAdvancesOnlyAfterACPSettlement(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationDelete} {
		for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionNotSettled, ports.ExecutionRuntimeBarrierRequired, "transport-error"} {
			t.Run(string(kind)+"/"+outcome, func(t *testing.T) {
				now := time.Now().UTC()
				deadline := now.Add(time.Minute)
				agent := ports.AgentRecord{AgentID: "agent-1", OrganizationID: "org-1"}
				operation := ports.LifecycleOperationRecord{RequestID: "operation-1", AgentID: agent.AgentID, Kind: kind, Phase: domain.PhaseDrain, DrainDeadlineAt: &deadline}
				store := &lifecycleDrainStoreStub{}
				service := &LifecycleService{store: store, clock: fixedClock{now: now}, execution: lifecycleExecutionStub{settle: func(context.Context, ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
					require.Zero(t, store.advances)
					if outcome == "transport-error" {
						return ports.AgentSettlementResult{}, errors.New("synthetic ACP failure")
					}
					return ports.AgentSettlementResult{AppliedRevision: 3, Outcome: outcome}, nil
				}}}
				phase, err := exerciseDrain(t.Context(), service, agent, operation)
				if outcome == "transport-error" {
					require.Error(t, err)
				} else {
					require.NoError(t, err)
				}
				if outcome == ports.ExecutionSettled || outcome == ports.ExecutionRuntimeBarrierRequired {
					require.Equal(t, 1, store.advances)
					require.Equal(t, domain.PhaseNetworkFence, phase)
				} else {
					require.Zero(t, store.advances)
					require.Equal(t, domain.PhaseDrain, phase)
				}
			})
		}
	}
}

func exerciseDrain(ctx context.Context, service *LifecycleService, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) (domain.OperationPhase, error) {
	switch operation.Kind {
	case domain.OperationRebuild:
		result, err := service.settleRebuildDrain(ctx, ports.AgentRebuildState{Agent: agent, Operation: operation})
		return result.Operation.Phase, err
	case domain.OperationDisable:
		result, err := service.settleDisableDrain(ctx, ports.AgentDisableState{Agent: agent, Operation: operation})
		return result.Operation.Phase, err
	default:
		result, err := service.settleDeleteDrain(ctx, ports.AgentDeleteState{Agent: agent, Operation: operation})
		return result.Operation.Phase, err
	}
}
