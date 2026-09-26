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
	OwnerRevocationSequence int64
	RequestID               string
	OrganizationID          string
	ActorPrincipalID        string
	AgentID                 string
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
		if !lifecycleScopeMatches(state.Agent.OrganizationID, input.OrganizationID) {
			return DisableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return disableAgentResult(state), nil
	}

	base, err := service.store.GetAgentLifecycleBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return DisableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return DisableAgentResult{}, fmt.Errorf("load Agent disable source: %w", err)
	}
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return DisableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
	}
	if err := validateDisableSource(base); err != nil {
		return DisableAgentResult{}, err
	}
	if input.OwnerRevocationSequence > 0 && (!base.Agent.IdentityRevoked() || base.Agent.IdentityRevocationSequence != input.OwnerRevocationSequence) {
		return DisableAgentResult{}, fmt.Errorf("%w: owner revocation changed", ErrLifecycleConflict)
	}
	now := service.clock.Now()
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: input.AgentID, Kind: domain.OperationDisable,
		SourceSpecRevision:      base.ConfiguredSpec.ID,
		SourceExecutionRevision: base.SourceExecution.ID,
		SourceRuntimeRevision:   base.Agent.RuntimeRevision,
		Now:                     now,
	})
	if err != nil {
		return DisableAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	state, _, err = service.store.BeginAgentDisable(ctx, ports.BeginAgentDisable{
		AgentID:                     input.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ConfiguredSpec.ID,
		ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			DrainDeadlineAt:         service.drainDeadline(now),
			OwnerRevocationSequence: input.OwnerRevocationSequence,
			RequestID:               input.RequestID, RequestFingerprint: fingerprint,
			AgentID: input.AgentID, Kind: domain.OperationDisable,
			Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID:      base.ConfiguredSpec.ID,
			SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			ChildRequestID:            operation.ChildRequestID(),
			CreatedAt:                 now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-disable-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDisableRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"owner_revocation_sequence":     input.OwnerRevocationSequence,
				"actor_principal_id":            input.ActorPrincipalID,
				"source_agent_spec_revision_id": base.ConfiguredSpec.ID,
				"source_execution_revision_id":  base.SourceExecution.ID,
				"source_runtime_revision":       base.Agent.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return DisableAgentResult{}, fmt.Errorf("begin Agent disable: %w", err)
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
	outcome, err := service.settleLifecycleExecution(ctx, state.Agent, state.Operation)
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil && !service.clock.Now().Before(*state.Operation.DrainDeadlineAt) {
		return service.failAgentDisable(
			ctx, state, "run_drain_timeout",
			"Agent execution did not settle before the deadline", true, nil, nil,
		)
	}
	if err != nil || outcome == ports.ExecutionNotSettled {
		return state, err
	}
	operation, err := service.confirmLifecycleDrain(ctx, state.Operation, outcome)
	if err != nil {
		return state, err
	}
	state.Operation = operation
	return state, nil
}

func (service *LifecycleService) fenceDisableNetwork(
	ctx context.Context, state ports.AgentDisableState,
) (ports.AgentDisableState, error) {
	attachment, err := service.setCurrentNetworkAttachmentState(
		ctx, state.Operation, ports.NetworkAttachmentClosed,
	)
	if err != nil {
		return service.handleDisableDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return service.failAgentDisable(
			ctx, state, "network_attachment_close_unconfirmed",
			"Runtime Egress did not confirm the closed attachment", true, nil, nil,
		)
	}
	return service.store.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(
			state.Operation.RequestID, domain.PhaseRuntimeDisable,
		),
		NetworkAttachment: &attachment, Now: service.clock.Now(),
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
		Now:                now,
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
			EventID:           domain.DeriveResourceID("event", "event-disabled", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisabled,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id":                state.SourceSpec.ID,
				"last_successful_execution_revision_id": state.Agent.LastSuccessfulExecutionRevisionID,
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
	if preserveExecutable && state.Operation.NetworkAttachment != nil {
		if err := service.restoreNetworkUnlessRevoked(ctx, state.Operation, state.Operation.OwnerRevocationSequence); err != nil {
			return state, fmt.Errorf("%w: runtime-egress attachment restoration", ErrDependencyUnavailable)
		}
	}
	now := service.clock.Now()
	return service.store.FailAgentDisable(ctx, ports.FailAgentDisable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedAggregateSequence: state.Agent.AggregateSequence,
		Stage:                     state.Operation.Phase, Code: code, Detail: detail,
		PreserveExecutable: preserveExecutable, SourceRuntimeInspection: inspection,
		RuntimeAbsenceProof: absenceProof,
		FailedEvent: ports.AgentEventRecord{
			EventID:       domain.DeriveResourceID("event", "event-disable-failed", state.Operation.RequestID),
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
	return exactRuntimeSource(
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
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) || input.OwnerRevocationSequence < 0 {
		return fmt.Errorf("%w: Agent disable input", ErrInvalidInput)
	}
	return nil
}

func validateDisableSource(base ports.AgentLifecycleBase) error {
	agent := base.Agent
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	source := ports.AgentRuntimeSource{Spec: base.ConfiguredSpec, Execution: base.SourceExecution}
	if !agent.AllowsDisableRequest() || !source.MatchesAgent(agent) {
		return fmt.Errorf("%w: Agent has no configured disable source", ErrAgentNotReady)
	}
	return nil
}

func disableAgentFingerprint(input DisableAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID               string
		OrganizationID          string
		ActorPrincipalID        string
		AgentID                 string
		OwnerRevocationSequence int64 `json:",omitempty"`
	}{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID,
		OwnerRevocationSequence: input.OwnerRevocationSequence,
	})
}

func disableAgentResult(state ports.AgentDisableState) DisableAgentResult {
	return DisableAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
