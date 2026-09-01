package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type DisableAgentInput struct {
	RequestID          string
	AgentID            string
	InitialTraceParent string
}

type DisableAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) DisableAgent(
	ctx context.Context, input DisableAgentInput,
) (DisableAgentResult, error) {
	if err := validateDisableAgentInput(input); err != nil {
		return DisableAgentResult{}, err
	}
	fingerprint, err := disableAgentFingerprint(input)
	if err != nil {
		return DisableAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentDisable(ctx, input.RequestID, fingerprint)
	if err != nil {
		return DisableAgentResult{}, fmt.Errorf("replay Agent disable: %w", err)
	}
	if found {
		return service.convergeAgentDisable(ctx, state, fingerprint)
	}

	base, err := service.store.GetAgentLifecycleBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return DisableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return DisableAgentResult{}, fmt.Errorf("load Agent disable source: %w", err)
	}
	if err := validateDisableSource(base); err != nil {
		return DisableAgentResult{}, err
	}
	now := service.clock.Now()
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: input.AgentID, Kind: domain.OperationDisable,
		SourceSpecRevision:      base.ExecutableSpec.ID,
		SourceExecutionRevision: base.ExecutableExecution.ID,
		SourceRuntimeRevision:   base.Agent.RuntimeRevision,
		InitialTraceParent:      input.InitialTraceParent, Now: now,
	})
	if err != nil {
		return DisableAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	state, _, err = service.store.BeginAgentDisable(ctx, ports.BeginAgentDisable{
		AgentID:                     input.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ExecutableSpec.ID,
		ExpectedExecutionRevisionID: base.ExecutableExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint,
			AgentID: input.AgentID, Kind: domain.OperationDisable,
			Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID:      base.ExecutableSpec.ID,
			SourceExecutionRevisionID: base.ExecutableExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			ChildRequestID:            operation.ChildRequestID(),
			InitialTraceParent:        input.InitialTraceParent, Attempt: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-disable-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDisableRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"source_agent_spec_revision_id": base.ExecutableSpec.ID,
				"source_execution_revision_id":  base.ExecutableExecution.ID,
				"source_runtime_revision":       base.Agent.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return DisableAgentResult{}, fmt.Errorf("begin Agent disable: %w", err)
	}
	return service.convergeAgentDisable(ctx, state, fingerprint)
}

func (service *LifecycleService) convergeAgentDisable(
	ctx context.Context, state ports.AgentDisableState, fingerprint string,
) (DisableAgentResult, error) {
	for range maximumLifecycleConvergenceAttempts {
		result, err := service.continueAgentDisable(ctx, state)
		if !errors.Is(err, ports.ErrConcurrentChange) {
			return result, err
		}
		var found bool
		state, found, err = service.store.ReplayAgentDisable(
			ctx, state.Operation.RequestID, fingerprint,
		)
		if err != nil {
			return DisableAgentResult{}, fmt.Errorf("replay concurrent Agent disable: %w", err)
		}
		if !found {
			return DisableAgentResult{}, fmt.Errorf("concurrent Agent disable disappeared")
		}
	}
	return DisableAgentResult{}, ports.ErrConcurrentChange
}

func (service *LifecycleService) continueAgentDisable(
	ctx context.Context, state ports.AgentDisableState,
) (DisableAgentResult, error) {
	if state.Operation.State != domain.OperationRunning {
		return disableAgentResult(state), nil
	}
	if lifecycleOperationReservedForRecovery(state.Operation) {
		return disableAgentResult(state), nil
	}
	for state.Operation.State == domain.OperationRunning {
		phase := state.Operation.Phase
		next, err := service.stepAgentDisable(ctx, state)
		if err != nil {
			return disableAgentResult(next), err
		}
		state = next
		if state.Operation.Phase == phase {
			break
		}
	}
	return disableAgentResult(state), nil
}

func (service *LifecycleService) stepAgentDisable(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	switch state.Operation.Phase {
	case domain.PhaseDrain:
		return service.settleDisableDrain(ctx, state)
	case domain.PhaseNetworkFence:
		return service.fenceDisableNetwork(ctx, state)
	case domain.PhaseRuntimeDisable:
		return service.disableRuntime(ctx, state)
	case domain.PhasePublish:
		return service.publishAgentDisable(ctx, state)
	default:
		return state, fmt.Errorf("invalid disable operation phase %q", state.Operation.Phase)
	}
}

func (service *LifecycleService) settleDisableDrain(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	settled, err := service.store.SettleAgentDisableDrain(
		ctx, state.Operation.RequestID, state.Operation.RequestFingerprint,
		domain.ChildRequestID(state.Operation.RequestID, domain.PhaseNetworkFence),
		service.clock.Now(),
	)
	if err != nil || settled.Operation.Phase != domain.PhaseDrain {
		return settled, err
	}
	if !service.clock.Now().Before(state.Operation.CreatedAt.Add(service.drainTimeout)) {
		return service.failAgentDisable(
			ctx, settled, "run_drain_timeout",
			"active Run did not drain before the deadline", true, nil, nil,
		)
	}
	return settled, nil
}

func (service *LifecycleService) fenceDisableNetwork(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	if state.Operation.NetworkPolicyAssignment == nil {
		assignment, err := service.egress.GetAgentPolicyAssignment(ctx, state.Agent.AgentID)
		if err != nil {
			return service.handleDisableDependencyFailure(ctx, state, "runtime-egress", err)
		}
		if !networkPolicyAssignmentReady(assignment, state.Agent.AgentID) {
			return service.failAgentDisable(
				ctx, state, "invalid_network_policy_assignment",
				"Runtime Egress did not return the current policy assignment", true, nil, nil,
			)
		}
		state, err = service.store.RecordAgentDisablePolicy(
			ctx, state.Operation.RequestID, state.Operation.RequestFingerprint,
			assignment, service.clock.Now(),
		)
		if err != nil {
			return ports.AgentDisableState{}, err
		}
	}
	if err := service.egress.FenceAgentNetwork(
		ctx, state.Agent.AgentID, state.Operation.NetworkPolicyAssignment.ResourceVersion,
	); err != nil {
		return service.handleDisableDependencyFailure(ctx, state, "runtime-egress", err)
	}
	return service.store.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(
			state.Operation.RequestID, domain.PhaseRuntimeDisable,
		),
		Now: service.clock.Now(),
	})
}

func (service *LifecycleService) disableRuntime(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	result, err := service.runtime.DisableRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID,
		state.Operation.SourceRuntimeRevision,
	)
	if err != nil {
		return service.handleDisableDependencyFailure(ctx, state, "runtime-controller", err)
	}
	switch result.State {
	case "running", "unknown":
		return state, nil
	case "failed":
		if result.Effect == "unknown" {
			return state, fmt.Errorf("%w: runtime-controller", ErrDependencyUnavailable)
		}
		code := strings.TrimSpace(result.ErrorCode)
		if code == "" {
			code = "runtime_disable_failed"
		}
		return service.failDisableAfterRuntimeRejection(ctx, state, code, result.ErrorDetail)
	case "completed":
		if !completedDisabledRuntime(result) {
			return state, fmt.Errorf(
				"%w: runtime-controller returned an unprovable disabled effect",
				ErrDependencyUnavailable,
			)
		}
	default:
		return state, fmt.Errorf(
			"%w: runtime-controller returned an unknown state", ErrDependencyUnavailable,
		)
	}
	now := service.clock.Now()
	return service.store.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseRuntimeDisable, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhasePublish),
		RuntimeResult:      &result,
		RunReleaseEvent: lifecycleRunReleaseEvent(
			ctx, state.Operation.RequestID, "runtime_disabled",
			state.Operation.SourceRuntimeRevision, now,
		),
		Now: now,
	})
}

func (service *LifecycleService) publishAgentDisable(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	if state.Operation.RuntimeResult == nil || !completedDisabledRuntime(*state.Operation.RuntimeResult) {
		return ports.AgentDisableState{}, fmt.Errorf("disable operation has no proven Runtime result")
	}
	now := service.clock.Now()
	return service.store.PublishAgentDisable(ctx, ports.PublishAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		DisabledEvent: ports.AgentEventRecord{
			EventID:           derivedID("event-disabled", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisabled,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id":                state.SourceSpec.ID,
				"last_successful_execution_revision_id": state.SourceExecution.ID,
				"runtime_revision":                      state.Operation.RuntimeResult.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func (service *LifecycleService) handleDisableDependencyFailure(
	ctx context.Context, state ports.AgentDisableState, serviceName string, err error,
) (ports.AgentDisableState, error) {
	var dependencyFailure *ports.DependencyError
	if !errors.As(err, &dependencyFailure) || dependencyFailure.Retryable {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	if serviceName == "runtime-controller" && state.Operation.Phase == domain.PhaseRuntimeDisable {
		return service.failDisableAfterRuntimeRejection(
			ctx, state, dependencyFailure.Code, dependencyFailure.Error(),
		)
	}
	return service.failAgentDisable(
		ctx, state, dependencyFailure.Code, dependencyFailure.Error(), true, nil, nil,
	)
}

func (service *LifecycleService) failAgentDisable(
	ctx context.Context,
	state ports.AgentDisableState,
	code string,
	detail string,
	preserveExecutable bool,
	inspection *ports.RuntimeInspection,
	absenceProof *ports.RuntimeAbsenceProof,
) (ports.AgentDisableState, error) {
	if preserveExecutable && state.Operation.NetworkPolicyAssignment != nil {
		if _, err := service.restoreCapturedNetwork(
			ctx, state.Agent.AgentID, *state.Operation.NetworkPolicyAssignment,
		); err != nil {
			return state, fmt.Errorf("%w: runtime-egress policy restoration", ErrDependencyUnavailable)
		}
	}
	now := service.clock.Now()
	releaseEvent := ports.RunAdmissionEvent{}
	if absenceProof != nil {
		releaseEvent = lifecycleRunReleaseEvent(
			ctx, state.Operation.RequestID, absenceProof.Reason,
			state.Operation.SourceRuntimeRevision, now,
		)
	}
	return service.store.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedAggregateSequence: state.Agent.AggregateSequence,
		Stage:                     state.Operation.Phase, Code: code, Detail: detail,
		PreserveExecutable: preserveExecutable, SourceRuntimeInspection: inspection,
		RuntimeAbsenceProof: absenceProof, RunReleaseEvent: releaseEvent,
		FailedEvent: ports.AgentEventRecord{
			EventID:       derivedID("event-disable-failed", state.Operation.RequestID),
			AgentID:       state.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentDisableFailed,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"failure_stage": state.Operation.Phase,
				"failure_code":  code,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func (service *LifecycleService) failDisableAfterRuntimeRejection(
	ctx context.Context, state ports.AgentDisableState, code string, detail string,
) (ports.AgentDisableState, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
			return state, fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
		}
		return state, fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
	}
	preserve := exactDisableSourceRuntime(state, inspection)
	if preserve {
		return service.failAgentDisable(ctx, state, code, detail, true, &inspection, nil)
	}
	proof, absent := deletedRuntimeAbsenceProof(
		state.Agent.AgentID, state.Operation.SourceRuntimeRevision,
		inspection, service.clock.Now(),
	)
	if absent {
		return service.failAgentDisable(ctx, state, code, detail, false, nil, proof)
	}
	return service.failAgentDisable(ctx, state, code, detail, false, &inspection, nil)
}

func exactDisableSourceRuntime(
	state ports.AgentDisableState, inspection ports.RuntimeInspection,
) bool {
	return exactReadyRuntime(
		state.Agent.AgentID, state.Operation.SourceRuntimeRevision,
		state.SourceExecution.RuntimeExecutionID,
		state.SourceExecution.RuntimeMCPEndpoint, inspection,
	)
}

func completedDisabledRuntime(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "disabled" && result.Health == "absent" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}

func validateDisableAgentInput(input DisableAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) {
		return fmt.Errorf("%w: Agent disable input", ErrInvalidInput)
	}
	return nil
}

func validateDisableSource(base ports.AgentLifecycleBase) error {
	agent := base.Agent
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	if agent.DesiredState != domain.DesiredEnabled || agent.LifecycleState != domain.AgentAvailable ||
		agent.AgentSpecRevisionID == "" || agent.ExecutionRevisionID == "" ||
		agent.LastSuccessfulExecutionRevisionID != agent.ExecutionRevisionID ||
		agent.RuntimeRevision == "" || agent.RuntimeExecutionID == "" ||
		agent.RuntimeMCPEndpoint == "" || base.ExecutableSpec.ID != agent.AgentSpecRevisionID ||
		base.ExecutableExecution.ID != agent.ExecutionRevisionID ||
		base.ExecutableExecution.AgentSpecRevisionID != base.ExecutableSpec.ID ||
		base.ExecutableExecution.RuntimeRevision != agent.RuntimeRevision {
		return fmt.Errorf("%w: Agent is not a complete available disable source", ErrAgentNotReady)
	}
	return nil
}

func disableAgentFingerprint(input DisableAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID string
		AgentID   string
	}{RequestID: input.RequestID, AgentID: input.AgentID})
}

func disableAgentResult(state ports.AgentDisableState) DisableAgentResult {
	return DisableAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
