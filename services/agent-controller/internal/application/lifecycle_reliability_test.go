package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type reliabilityStoreStub struct {
	ports.LifecycleStore
	operation       ports.LifecycleOperationRecord
	operationErr    error
	base            ports.AgentLifecycleBase
	baseErr         error
	terminateInput  ports.TerminateLifecycleOperation
	terminateResult ports.LifecycleOperationRecord
	terminateErr    error
	terminateCalls  int
	clearInput      ports.ClearLifecycleQuarantine
	clearResult     ports.AgentRecord
	clearErr        error
	clearCalls      int
}

var _ ports.LifecycleReliabilityStore = (*reliabilityStoreStub)(nil)

func (stub *reliabilityStoreStub) GetLifecycleOperation(
	context.Context, string,
) (ports.LifecycleOperationRecord, error) {
	return stub.operation, stub.operationErr
}

func (stub *reliabilityStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return stub.base, stub.baseErr
}

func (stub *reliabilityStoreStub) TerminateLifecycleOperation(
	_ context.Context, input ports.TerminateLifecycleOperation,
) (ports.LifecycleOperationRecord, error) {
	stub.terminateCalls++
	stub.terminateInput = input
	return stub.terminateResult, stub.terminateErr
}

func (stub *reliabilityStoreStub) ClearLifecycleQuarantine(
	_ context.Context, input ports.ClearLifecycleQuarantine,
) (ports.AgentRecord, error) {
	stub.clearCalls++
	stub.clearInput = input
	return stub.clearResult, stub.clearErr
}

type legacyOnlyStoreStub struct {
	ports.LifecycleStore
	operation ports.LifecycleOperationRecord
}

func (stub *legacyOnlyStoreStub) GetLifecycleOperation(
	context.Context, string,
) (ports.LifecycleOperationRecord, error) {
	return stub.operation, nil
}

type reliabilityRuntimeStub struct {
	ports.RuntimeClient
	inspection ports.RuntimeInspection
	err        error
	calls      int
}

func (stub *reliabilityRuntimeStub) InspectRuntime(
	context.Context, string,
) (ports.RuntimeInspection, error) {
	stub.calls++
	return stub.inspection, stub.err
}

func reliabilityOperation(requestID string, kind domain.OperationKind, phase domain.OperationPhase, state domain.OperationState) ports.LifecycleOperationRecord {
	return ports.LifecycleOperationRecord{
		RequestID: requestID, RequestFingerprint: "fingerprint-" + requestID,
		AgentID: "agent-1", Kind: kind, Phase: phase, State: state,
	}
}

func reliabilityService(store ports.LifecycleStore, runtime ports.RuntimeClient) *LifecycleService {
	return newTestLifecycleService(nil, store, nil, runtime, fixedClock{now: time.Unix(100, 0).UTC()})
}

func TestTerminateLifecycleMarksOperationTerminal(t *testing.T) {
	for _, kind := range []domain.OperationKind{
		domain.OperationCreate, domain.OperationRebuild, domain.OperationDisable,
		domain.OperationEnable, domain.OperationDelete,
	} {
		t.Run(string(kind), func(t *testing.T) {
			for _, code := range []string{"phase_deadline_exceeded", "lifecycle_cancelled"} {
				plan, err := domain.OperationPlan(kind)
				require.NoError(t, err)
				phase := plan[0]
				result := reliabilityOperation("request-1", kind, phase, domain.OperationFailed)
				result.ErrorCode = code
				stub := &reliabilityStoreStub{
					operation:       reliabilityOperation("request-1", kind, phase, domain.OperationRunning),
					terminateResult: result,
				}
				service := reliabilityService(stub, nil)
				view, err := service.TerminateLifecycle(t.Context(), LifecycleTermination{
					RequestID: "request-1", Phase: phase, Code: code, Detail: "bounded lifecycle ended",
				})
				require.NoError(t, err)
				require.Equal(t, "request-1", view.RequestID)
				require.Equal(t, domain.OperationFailed, view.State)
				require.Equal(t, code, view.ErrorCode)
				require.Equal(t, 1, stub.terminateCalls)
				require.Equal(t, "request-1", stub.terminateInput.RequestID)
				require.Equal(t, phase, stub.terminateInput.ExpectedPhase)
				require.Equal(t, code, stub.terminateInput.ErrorCode)
				require.Equal(t, "fingerprint-request-1", stub.terminateInput.Fingerprint)
				require.NotEmpty(t, stub.terminateInput.EventID)
			}
		})
	}
}

func TestTerminateLifecycleValidatesBeforeStore(t *testing.T) {
	stub := &reliabilityStoreStub{
		operation: reliabilityOperation("request-1", domain.OperationDisable, domain.PhaseDrain, domain.OperationRunning),
	}
	service := reliabilityService(stub, nil)
	for _, termination := range []LifecycleTermination{
		{RequestID: "", Phase: domain.PhaseDrain, Code: "lifecycle_cancelled"},
		{RequestID: " request-1", Phase: domain.PhaseDrain, Code: "lifecycle_cancelled"},
		{RequestID: "request 1", Phase: domain.PhaseDrain, Code: "lifecycle_cancelled"},
		{RequestID: "request-1 ", Phase: domain.PhaseDrain, Code: "lifecycle_cancelled"},
		{RequestID: "request-1", Phase: domain.PhaseDrain, Code: "build_failed"},
		{RequestID: "request-1", Phase: domain.PhaseDrain, Code: "lifecycle_invariant_failed"},
		{RequestID: "request-1", Phase: domain.PhaseDrain, Code: ""},
		{RequestID: "request-1", Phase: domain.PhaseCompleted, Code: "lifecycle_cancelled"},
		{RequestID: "request-1", Phase: domain.PhaseNetworkEnsure, Code: "lifecycle_cancelled"},
	} {
		_, err := service.TerminateLifecycle(t.Context(), termination)
		require.Error(t, err)
	}
	require.Equal(t, 0, stub.terminateCalls)
}

func TestTerminateLifecycleReplaysTerminalAndPropagatesStalePhase(t *testing.T) {
	result := reliabilityOperation("request-1", domain.OperationCreate, domain.PhasePublish, domain.OperationFailed)
	result.ErrorCode = "lifecycle_cancelled"
	stub := &reliabilityStoreStub{operation: result, terminateResult: result}
	service := reliabilityService(stub, nil)
	for range 2 {
		view, err := service.TerminateLifecycle(t.Context(), LifecycleTermination{
			RequestID: "request-1", Phase: domain.PhasePublish, Code: "lifecycle_cancelled",
		})
		require.NoError(t, err)
		require.Equal(t, domain.OperationFailed, view.State)
		require.Equal(t, "lifecycle_cancelled", view.ErrorCode)
	}
	completed := reliabilityOperation("request-done", domain.OperationDisable, domain.PhasePublish, domain.OperationCompleted)
	stub2 := &reliabilityStoreStub{operation: completed, terminateResult: result}
	service2 := reliabilityService(stub2, nil)
	doneView, doneErr := service2.TerminateLifecycle(t.Context(), LifecycleTermination{
		RequestID: "request-done", Phase: domain.PhasePublish, Code: "phase_deadline_exceeded",
	})
	require.NoError(t, doneErr)
	require.Equal(t, domain.OperationCompleted, doneView.State)
	require.Equal(t, 0, stub2.terminateCalls)
	stale := &reliabilityStoreStub{
		operation: reliabilityOperation("request-2", domain.OperationRebuild, domain.PhaseDrain, domain.OperationRunning),
	}
	service = reliabilityService(stale, nil)
	_, err := service.TerminateLifecycle(t.Context(), LifecycleTermination{
		RequestID: "request-2", Phase: domain.PhaseNetworkFence, Code: "phase_deadline_exceeded",
	})
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.Equal(t, 0, stale.terminateCalls)
	storeCAS := &reliabilityStoreStub{
		operation: reliabilityOperation("request-3", domain.OperationRebuild, domain.PhaseDrain, domain.OperationRunning),
	}
	storeCAS.terminateErr = ports.ErrConcurrentChange
	service = reliabilityService(storeCAS, nil)
	_, err = service.TerminateLifecycle(t.Context(), LifecycleTermination{
		RequestID: "request-3", Phase: domain.PhaseDrain, Code: "phase_deadline_exceeded",
	})
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.Equal(t, 1, storeCAS.terminateCalls)
}

func TestTerminateLifecycleRequiresReliabilityStore(t *testing.T) {
	service := reliabilityService(&legacyOnlyStoreStub{
		operation: reliabilityOperation("request-1", domain.OperationDelete, domain.PhaseDrain, domain.OperationRunning),
	}, nil)
	_, err := service.TerminateLifecycle(t.Context(), LifecycleTermination{
		RequestID: "request-1", Phase: domain.PhaseDrain, Code: "lifecycle_cancelled",
	})
	require.ErrorIs(t, err, ErrDependencyUnavailable)
}

func reliabilityClearBase() ports.AgentLifecycleBase {
	return ports.AgentLifecycleBase{
		Agent: ports.AgentRecord{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
			ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
			AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-rev-1",
			AggregateSequence: 7, FailureCode: "lifecycle_invariant_failed",
		},
		ConfiguredSpec: ports.AgentSpecRecord{ID: "spec-1", AgentID: "agent-1", Revision: 1},
	}
}

func reliabilityClearRequest() ClearLifecycleQuarantineInput {
	return ClearLifecycleQuarantineInput{
		OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		AgentID: "agent-1", ExpectedAggregateSequence: 7,
	}
}

func reliabilityClearInspection() ports.RuntimeInspection {
	return ports.RuntimeInspection{
		AgentID: "agent-1", RuntimeRevision: "runtime-rev-1", Phase: "absent",
		LifecycleState: "disabled", Health: "absent", ObservedAt: time.Unix(50, 0).UTC(),
	}
}

func TestClearLifecycleQuarantineReturnsAgentOnSuccess(t *testing.T) {
	stub := &reliabilityStoreStub{
		base:        reliabilityClearBase(),
		clearResult: reliabilityClearBase().Agent,
	}
	stub.clearResult.FailureCode = ""
	stub.clearResult.AggregateSequence = 8
	runtime := &reliabilityRuntimeStub{inspection: reliabilityClearInspection()}
	service := reliabilityService(stub, runtime)
	view, err := service.ClearLifecycleQuarantine(t.Context(), reliabilityClearRequest())
	require.NoError(t, err)
	require.Equal(t, "agent-1", view.AgentID)
	require.Equal(t, 1, runtime.calls)
	require.Equal(t, 1, stub.clearCalls)
	require.Equal(t, "agent-1", stub.clearInput.AgentID)
	require.Equal(t, "org-1", stub.clearInput.OrganizationID)
	require.Equal(t, "admin-1", stub.clearInput.ActorPrincipalID)
	require.Equal(t, int64(7), stub.clearInput.ExpectedAggregateSequence)
	require.Equal(t, "spec-1", stub.clearInput.ExpectedSpecRevisionID)
	require.Equal(t, "runtime-rev-1", stub.clearInput.ExpectedRuntimeRevision)
	require.Equal(t, reliabilityClearInspection(), stub.clearInput.Inspection)
	require.NotEmpty(t, stub.clearInput.EventID)
}

func TestClearLifecycleQuarantineValidatesBeforeAnyAccess(t *testing.T) {
	for _, mutate := range []struct {
		name  string
		apply func(*ClearLifecycleQuarantineInput)
	}{
		{"empty organization", func(i *ClearLifecycleQuarantineInput) { i.OrganizationID = "" }},
		{"empty actor", func(i *ClearLifecycleQuarantineInput) { i.ActorPrincipalID = "" }},
		{"empty agent", func(i *ClearLifecycleQuarantineInput) { i.AgentID = "" }},
		{"zero sequence", func(i *ClearLifecycleQuarantineInput) { i.ExpectedAggregateSequence = 0 }},
		{"negative sequence", func(i *ClearLifecycleQuarantineInput) { i.ExpectedAggregateSequence = -1 }},
		{"unsafe sequence", func(i *ClearLifecycleQuarantineInput) { i.ExpectedAggregateSequence = 1 << 53 }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			stub := &reliabilityStoreStub{base: reliabilityClearBase()}
			runtime := &reliabilityRuntimeStub{inspection: reliabilityClearInspection()}
			service := reliabilityService(stub, runtime)
			input := reliabilityClearRequest()
			mutate.apply(&input)
			_, err := service.ClearLifecycleQuarantine(t.Context(), input)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Equal(t, 0, runtime.calls)
			require.Equal(t, 0, stub.clearCalls)
		})
	}
}

func TestClearLifecycleQuarantineScopeAndSequenceConflicts(t *testing.T) {
	stub := &reliabilityStoreStub{base: reliabilityClearBase()}
	runtime := &reliabilityRuntimeStub{inspection: reliabilityClearInspection()}
	service := reliabilityService(stub, runtime)
	input := reliabilityClearRequest()
	input.OrganizationID = "org-other"
	_, err := service.ClearLifecycleQuarantine(t.Context(), input)
	require.ErrorIs(t, err, ErrAgentNotFound)
	input = reliabilityClearRequest()
	input.ExpectedAggregateSequence = 6
	_, err = service.ClearLifecycleQuarantine(t.Context(), input)
	require.ErrorIs(t, err, ErrLifecycleConflict)
	require.Equal(t, 0, runtime.calls)
	require.Equal(t, 0, stub.clearCalls)
	missing := &reliabilityStoreStub{baseErr: ports.ErrNotFound}
	service = reliabilityService(missing, runtime)
	_, err = service.ClearLifecycleQuarantine(t.Context(), reliabilityClearRequest())
	require.ErrorIs(t, err, ErrAgentNotFound)
}

func TestClearLifecycleQuarantineRejectsBrokenInvariantsWithoutMutation(t *testing.T) {
	for _, scenario := range []struct {
		name        string
		base        func(*ports.AgentLifecycleBase)
		inspection  func(*ports.RuntimeInspection)
		nilRuntime  bool
		runtimeErr  error
		expectError error
	}{
		{"no invariant failure", func(b *ports.AgentLifecycleBase) {
			b.Agent.FailureCode = "build_failed"
		}, nil, false, nil, ErrLifecycleConflict},
		{"active operation", func(b *ports.AgentLifecycleBase) {
			b.Agent.ActiveOperationRequestID = "request-1"
		}, nil, false, nil, ErrLifecycleConflict},
		{"missing runtime dependency", nil, nil, true, nil, ErrDependencyUnavailable},
		{"runtime inspection failed", nil, nil, false, errors.New("unreachable"), ErrDependencyUnavailable},
		{"runtime absent", nil, nil, false, ports.ErrNotFound, ErrDependencyUnavailable},
		{"runtime still running", nil, func(i *ports.RuntimeInspection) {
			i.Phase = "running"
		}, false, nil, ErrLifecycleConflict},
		{"runtime still executes", nil, func(i *ports.RuntimeInspection) {
			i.RuntimeExecutionID = "exec-1"
		}, false, nil, ErrLifecycleConflict},
		{"inspection forged agent", nil, func(i *ports.RuntimeInspection) {
			i.AgentID = "agent-other"
		}, false, nil, ErrLifecycleConflict},
		{"inspection forged revision", nil, func(i *ports.RuntimeInspection) {
			i.RuntimeRevision = "rev-other"
		}, false, nil, ErrLifecycleConflict},
		{"inspection not observed", nil, func(i *ports.RuntimeInspection) {
			i.ObservedAt = time.Time{}
		}, false, nil, ErrLifecycleConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			base := reliabilityClearBase()
			if scenario.base != nil {
				scenario.base(&base)
			}
			inspection := reliabilityClearInspection()
			if scenario.inspection != nil {
				scenario.inspection(&inspection)
			}
			stub := &reliabilityStoreStub{base: base}
			var runtime *reliabilityRuntimeStub
			var client ports.RuntimeClient
			if !scenario.nilRuntime {
				runtime = &reliabilityRuntimeStub{inspection: inspection, err: scenario.runtimeErr}
				client = runtime
			}
			service := reliabilityService(stub, client)
			_, err := service.ClearLifecycleQuarantine(t.Context(), reliabilityClearRequest())
			require.ErrorIs(t, err, scenario.expectError)
			require.Equal(t, 0, stub.clearCalls)
		})
	}
}

func TestGetCancellableLifecycleOperationScopesAndValidates(t *testing.T) {
	operation := reliabilityOperation("request-1", domain.OperationDisable, domain.PhaseDrain, domain.OperationRunning)
	stub := &reliabilityStoreStub{operation: operation, base: reliabilityClearBase()}
	runtime := &reliabilityRuntimeStub{inspection: reliabilityClearInspection()}
	service := reliabilityService(stub, runtime)
	input := CancelLifecycleOperationInput{
		OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		AgentID: "agent-1", OperationRequestID: "request-1",
	}
	view, err := service.GetCancellableLifecycleOperation(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, "request-1", view.RequestID)
	require.Equal(t, 0, runtime.calls, "cancel lookup must not touch Runtime")
	for _, scenario := range []struct {
		name        string
		input       CancelLifecycleOperationInput
		baseErr     error
		expectError error
	}{
		{"empty organization", CancelLifecycleOperationInput{OrganizationID: "", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: "request-1"}, nil, ErrInvalidInput},
		{"empty actor", CancelLifecycleOperationInput{OrganizationID: "org-1", ActorPrincipalID: "", AgentID: "agent-1", OperationRequestID: "request-1"}, nil, ErrInvalidInput},
		{"empty agent", CancelLifecycleOperationInput{OrganizationID: "org-1", ActorPrincipalID: "admin-1", AgentID: "", OperationRequestID: "request-1"}, nil, ErrInvalidInput},
		{"empty request", CancelLifecycleOperationInput{OrganizationID: "org-1", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: ""}, nil, ErrInvalidInput},
		{"spaced request", CancelLifecycleOperationInput{OrganizationID: "org-1", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: "request 1"}, nil, ErrInvalidInput},
		{"foreign agent id", CancelLifecycleOperationInput{OrganizationID: "org-1", ActorPrincipalID: "admin-1", AgentID: "agent-2", OperationRequestID: "request-1"}, nil, ErrAgentNotFound},
		{"foreign organization", CancelLifecycleOperationInput{OrganizationID: "org-2", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: "request-1"}, nil, ErrAgentNotFound},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			_, err := service.GetCancellableLifecycleOperation(t.Context(), scenario.input)
			require.ErrorIs(t, err, scenario.expectError)
		})
	}
	missing := &reliabilityStoreStub{operationErr: ports.ErrNotFound, base: reliabilityClearBase()}
	service = reliabilityService(missing, runtime)
	_, err = service.GetCancellableLifecycleOperation(t.Context(), input)
	require.ErrorIs(t, err, ErrAgentNotFound)
	terminal := &reliabilityStoreStub{
		operation: reliabilityOperation("request-1", domain.OperationDisable, domain.PhaseDrain, domain.OperationCompleted),
		base:      reliabilityClearBase(),
	}
	service = reliabilityService(terminal, runtime)
	view, err = service.GetCancellableLifecycleOperation(t.Context(), input)
	require.NoError(t, err, "terminal operations remain resolvable for idempotent cancel")
	require.Equal(t, domain.OperationCompleted, view.State)
}

func TestClearLifecycleQuarantineMapsStaleStoreCAS(t *testing.T) {
	stub := &reliabilityStoreStub{
		base: reliabilityClearBase(), clearErr: ports.ErrConcurrentChange,
	}
	runtime := &reliabilityRuntimeStub{inspection: reliabilityClearInspection()}
	service := reliabilityService(stub, runtime)
	_, err := service.ClearLifecycleQuarantine(t.Context(), reliabilityClearRequest())
	require.ErrorIs(t, err, ErrLifecycleConflict)
	require.Equal(t, 1, stub.clearCalls)
}
