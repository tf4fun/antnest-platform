package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type DeleteAgentInput struct {
	RequestID          string
	AgentID            string
	InitialTraceParent string
}

type DeleteAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) DeleteAgent(
	ctx context.Context, input DeleteAgentInput,
) (DeleteAgentResult, error) {
	if err := validateDeleteAgentInput(input); err != nil {
		return DeleteAgentResult{}, err
	}
	fingerprint, err := deleteAgentFingerprint(input)
	if err != nil {
		return DeleteAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentDelete(ctx, input.RequestID, fingerprint)
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("replay Agent delete: %w", err)
	}
	if found {
		return service.convergeAgentDelete(ctx, state, fingerprint)
	}

	base, err := service.store.GetAgentDeleteBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return DeleteAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return DeleteAgentResult{}, fmt.Errorf("load Agent delete source: %w", err)
	}
	if err := validateDeleteSource(base.Agent); err != nil {
		return DeleteAgentResult{}, err
	}
	sourceRuntime, runtimeAbsent, sourceInspection, absenceProof, err := service.resolveDeleteRuntime(
		ctx, base.Agent,
	)
	if err != nil {
		return DeleteAgentResult{}, err
	}
	now := service.clock.Now()
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
		SourceRuntimeRevision: sourceRuntime, SourceRuntimeAbsent: runtimeAbsent,
		InitialTraceParent: input.InitialTraceParent, Now: now,
	})
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	state, _, err = service.store.BeginAgentDelete(ctx, ports.BeginAgentDelete{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedDesiredState:    base.Agent.DesiredState,
		ExpectedLifecycleState:  base.Agent.LifecycleState,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
			Phase: operation.Phase(), State: operation.State(),
			SourceRuntimeRevision: sourceRuntime, SourceRuntimeAbsent: runtimeAbsent,
			SourceRuntimeInspection:   sourceInspection,
			SourceRuntimeAbsenceProof: absenceProof,
			ChildRequestID:            operation.ChildRequestID(), InitialTraceParent: input.InitialTraceParent,
			Attempt: 1, CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-delete-requested", input.RequestID),
			AgentID: base.Agent.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleteRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"source_runtime_revision": sourceRuntime,
				"source_runtime_absent":   runtimeAbsent,
				"runtime_absence_reason":  runtimeAbsenceReason(absenceProof),
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("begin Agent delete: %w", err)
	}
	return service.convergeAgentDelete(ctx, state, fingerprint)
}

func (service *LifecycleService) resolveDeleteRuntime(
	ctx context.Context, agent ports.AgentRecord,
) (string, bool, *ports.RuntimeInspection, *ports.RuntimeAbsenceProof, error) {
	if agent.RuntimeRevision != "" {
		return agent.RuntimeRevision, false, nil, nil, nil
	}
	inspection, err := service.runtime.InspectRuntime(ctx, agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
			return "", true, nil, &ports.RuntimeAbsenceProof{
				Reason: "runtime_not_found", ObservedAt: service.clock.Now(),
			}, nil
		}
		return "", false, nil, nil,
			fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
	}
	if inspection.AgentID != agent.AgentID || strings.TrimSpace(inspection.RuntimeRevision) == "" {
		return "", false, nil, nil,
			fmt.Errorf("%w: invalid Runtime inspection", ErrDependencyUnavailable)
	}
	if runtimeInspectionProvesDeleted(agent.AgentID, inspection) {
		return "", true, nil, &ports.RuntimeAbsenceProof{
			Reason:          "runtime_deleted",
			RuntimeRevision: inspection.RuntimeRevision,
			ObservedAt:      service.clock.Now(),
		}, nil
	}
	return inspection.RuntimeRevision, false, &inspection, nil, nil
}

func (service *LifecycleService) convergeAgentDelete(
	ctx context.Context, state ports.AgentDeleteState, fingerprint string,
) (DeleteAgentResult, error) {
	for range maximumLifecycleConvergenceAttempts {
		result, err := service.continueAgentDelete(ctx, state)
		if !errors.Is(err, ports.ErrConcurrentChange) {
			return result, err
		}
		var found bool
		state, found, err = service.store.ReplayAgentDelete(
			ctx, state.Operation.RequestID, fingerprint,
		)
		if err != nil {
			return DeleteAgentResult{}, fmt.Errorf("replay concurrent Agent delete: %w", err)
		}
		if !found {
			return DeleteAgentResult{}, fmt.Errorf("concurrent Agent delete disappeared")
		}
	}
	return DeleteAgentResult{}, ports.ErrConcurrentChange
}

func (service *LifecycleService) continueAgentDelete(
	ctx context.Context, state ports.AgentDeleteState,
) (DeleteAgentResult, error) {
	if state.Operation.State != domain.OperationRunning {
		return deleteAgentResult(state), nil
	}
	if lifecycleOperationReservedForRecovery(ctx, state.Operation) {
		return deleteAgentResult(state), nil
	}
	var err error
	if state.Operation.Phase == domain.PhaseDrain {
		state, err = service.settleDeleteDrain(ctx, state)
		if err != nil || state.Operation.Phase == domain.PhaseDrain {
			return deleteAgentResult(state), err
		}
	}
	if state.Operation.Phase == domain.PhaseNetworkFence {
		state, err = service.fenceDeleteNetwork(ctx, state)
		if err != nil {
			return deleteAgentResult(state), err
		}
	}
	if state.Operation.Phase == domain.PhaseFlowReset {
		state, err = service.resetDeleteFlows(ctx, state)
		if err != nil {
			return deleteAgentResult(state), err
		}
	}
	if state.Operation.Phase == domain.PhaseRuntimeDelete {
		state, err = service.deleteRuntime(ctx, state)
		if err != nil || state.Operation.Phase == domain.PhaseRuntimeDelete {
			return deleteAgentResult(state), err
		}
	}
	if state.Operation.Phase == domain.PhaseNetworkRelease {
		state, err = service.releaseDeleteNetwork(ctx, state)
		if err != nil {
			return deleteAgentResult(state), err
		}
	}
	if state.Operation.Phase != domain.PhasePublish {
		return DeleteAgentResult{}, fmt.Errorf("invalid delete operation phase %q", state.Operation.Phase)
	}
	state, err = service.publishAgentDelete(ctx, state)
	if err != nil {
		return DeleteAgentResult{}, err
	}
	return deleteAgentResult(state), nil
}

func (service *LifecycleService) settleDeleteDrain(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	settled, err := service.store.SettleAgentDeleteDrain(
		ctx, state.Operation.RequestID, state.Operation.RequestFingerprint,
		domain.ChildRequestID(state.Operation.RequestID, domain.PhaseNetworkFence),
		service.clock.Now(),
	)
	if err != nil || settled.Operation.Phase != domain.PhaseDrain {
		return settled, err
	}
	if !service.clock.Now().Before(state.Operation.CreatedAt.Add(service.drainTimeout)) {
		return settled,
			fmt.Errorf("%w: active Run did not drain before Agent deletion", ErrDependencyUnavailable)
	}
	return settled, nil
}

func (service *LifecycleService) fenceDeleteNetwork(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	err := service.egress.FenceAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil && !dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
		return state, fmt.Errorf("%w: runtime-egress fence", ErrDependencyUnavailable)
	}
	return service.advanceAgentDelete(
		ctx, state, domain.PhaseNetworkFence, domain.PhaseFlowReset, nil, nil, "",
	)
}

func (service *LifecycleService) resetDeleteFlows(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	err := service.egress.ResetAgentFlows(ctx, state.Agent.AgentID)
	if err != nil && !dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
		return state, fmt.Errorf("%w: runtime-egress flow reset", ErrDependencyUnavailable)
	}
	next := domain.PhaseRuntimeDelete
	if state.Operation.SourceRuntimeAbsent {
		next = domain.PhaseNetworkRelease
	}
	return service.advanceAgentDelete(ctx, state, domain.PhaseFlowReset, next, nil, nil, "")
}

func (service *LifecycleService) deleteRuntime(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	result, err := service.runtime.DeleteRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID,
		state.Operation.SourceRuntimeRevision,
	)
	if err != nil {
		return service.reconcileDeletedRuntime(ctx, state)
	}
	switch result.State {
	case "running", "unknown":
		return state, nil
	case "failed":
		return service.reconcileDeletedRuntime(ctx, state)
	case "completed":
		if !completedDeletedRuntime(result) {
			return state, fmt.Errorf("%w: unprovable Runtime deletion", ErrDependencyUnavailable)
		}
		return service.recordDeletedRuntime(ctx, state, result)
	default:
		return state, fmt.Errorf("%w: invalid Runtime deletion state", ErrDependencyUnavailable)
	}
}

func (service *LifecycleService) reconcileDeletedRuntime(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
			return service.recordDeletedRuntime(ctx, state, observedDeletedRuntime(state, ""))
		}
		return state, fmt.Errorf("%w: runtime-controller deletion inspection", ErrDependencyUnavailable)
	}
	if !runtimeInspectionProvesDeleted(state.Agent.AgentID, inspection) {
		return state, fmt.Errorf("%w: Runtime deletion remains unproven", ErrDependencyUnavailable)
	}
	return service.recordDeletedRuntime(
		ctx, state, observedDeletedRuntime(state, inspection.RuntimeRevision),
	)
}

func (service *LifecycleService) recordDeletedRuntime(
	ctx context.Context, state ports.AgentDeleteState, result ports.RuntimeOperation,
) (ports.AgentDeleteState, error) {
	return service.advanceAgentDelete(
		ctx, state, domain.PhaseRuntimeDelete, domain.PhaseNetworkRelease, nil, &result, "",
	)
}

func (service *LifecycleService) releaseDeleteNetwork(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	attachment, err := service.egress.ReleaseAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
			return service.advanceAgentDelete(
				ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, nil, nil,
				ports.NetworkReleaseAuthoritativeNone,
			)
		}
		return state, fmt.Errorf("%w: runtime-egress release", ErrDependencyUnavailable)
	}
	if !networkAttachmentInState(attachment, state.Agent.AgentID, "quarantined") {
		return state, fmt.Errorf("%w: invalid released network attachment", ErrDependencyUnavailable)
	}
	return service.advanceAgentDelete(
		ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, &attachment, nil,
		ports.NetworkReleaseQuarantined,
	)
}

func (service *LifecycleService) advanceAgentDelete(
	ctx context.Context,
	state ports.AgentDeleteState,
	expected domain.OperationPhase,
	next domain.OperationPhase,
	attachment *ports.NetworkAttachment,
	runtime *ports.RuntimeOperation,
	networkReleaseOutcome string,
) (ports.AgentDeleteState, error) {
	now := service.clock.Now()
	releaseEvent := ports.RunAdmissionEvent{}
	if expected == domain.PhaseRuntimeDelete ||
		(expected == domain.PhaseFlowReset && state.Operation.SourceRuntimeAbsent) {
		reason := "runtime_deleted"
		if state.Operation.SourceRuntimeAbsent {
			reason = "runtime_absent"
		}
		releaseEvent = lifecycleRunReleaseEvent(
			ctx, state.Operation.RequestID, reason,
			state.Operation.SourceRuntimeRevision, now,
		)
	}
	return service.store.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: expected, NextPhase: next,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, next),
		NetworkAttachment:  attachment, RuntimeResult: runtime,
		RunReleaseEvent:       releaseEvent,
		NetworkReleaseOutcome: networkReleaseOutcome, Now: now,
	})
}

func (service *LifecycleService) publishAgentDelete(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	if state.Operation.SourceRuntimeAbsent &&
		!validRuntimeAbsenceProof(state.Operation.SourceRuntimeAbsenceProof) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no Runtime absence proof")
	}
	if !state.Operation.SourceRuntimeAbsent &&
		(state.Operation.RuntimeResult == nil || !completedDeletedRuntime(*state.Operation.RuntimeResult)) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no proven Runtime deletion")
	}
	if !validDeleteNetworkRelease(state.Operation, state.Agent.AgentID) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no proven network release")
	}
	now := service.clock.Now()
	return service.store.PublishAgentDelete(ctx, ports.PublishAgentDelete{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		DeletedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-deleted", state.Operation.RequestID),
			AgentID: state.Agent.AgentID, AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleted,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"source_runtime_revision": state.Operation.SourceRuntimeRevision,
				"source_runtime_absent":   state.Operation.SourceRuntimeAbsent,
				"runtime_absence_reason": runtimeAbsenceReason(
					state.Operation.SourceRuntimeAbsenceProof,
				),
				"network_release_outcome": state.Operation.NetworkReleaseOutcome,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func validateDeleteSource(agent ports.AgentRecord) error {
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	switch agent.LifecycleState {
	case domain.AgentAvailable:
		if agent.DesiredState != domain.DesiredEnabled || agent.RuntimeRevision == "" ||
			agent.RuntimeExecutionID == "" || agent.RuntimeMCPEndpoint == "" {
			return fmt.Errorf("%w: Agent available projection is incomplete", ErrAgentNotReady)
		}
	case domain.AgentDisabled:
		if agent.DesiredState != domain.DesiredDisabled || agent.RuntimeRevision == "" ||
			agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" {
			return fmt.Errorf("%w: Agent disabled projection is incomplete", ErrAgentNotReady)
		}
	case domain.AgentUnavailable:
		if agent.DesiredState == domain.DesiredDeleted {
			return fmt.Errorf("%w: Agent deletion is already in progress", ErrLifecycleConflict)
		}
	default:
		return fmt.Errorf("%w: Agent cannot enter deletion from %s", ErrAgentNotReady, agent.LifecycleState)
	}
	return nil
}

func completedDeletedRuntime(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "deleted" && result.Health == "absent" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}

func runtimeInspectionProvesDeleted(expectedAgentID string, inspection ports.RuntimeInspection) bool {
	return inspection.AgentID == expectedAgentID && inspection.RuntimeRevision != "" &&
		inspection.LifecycleState == "deleted" && inspection.Health == "absent" &&
		inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == ""
}

func validDeleteNetworkRelease(operation ports.LifecycleOperationRecord, agentID string) bool {
	switch operation.NetworkReleaseOutcome {
	case ports.NetworkReleaseQuarantined:
		return operation.NetworkAttachment != nil &&
			networkAttachmentInState(*operation.NetworkAttachment, agentID, "quarantined")
	case ports.NetworkReleaseAuthoritativeNone:
		return operation.NetworkAttachment == nil
	default:
		return false
	}
}

func runtimeAbsenceReason(proof *ports.RuntimeAbsenceProof) string {
	if proof == nil {
		return ""
	}
	return proof.Reason
}

func validRuntimeAbsenceProof(proof *ports.RuntimeAbsenceProof) bool {
	if proof == nil || proof.ObservedAt.IsZero() {
		return false
	}
	switch proof.Reason {
	case "runtime_not_found":
		return proof.RuntimeRevision == ""
	case "runtime_deleted":
		return proof.RuntimeRevision != ""
	default:
		return false
	}
}

func observedDeletedRuntime(
	state ports.AgentDeleteState, observedRevision string,
) ports.RuntimeOperation {
	if observedRevision == "" {
		observedRevision = state.Operation.SourceRuntimeRevision
	}
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: observedRevision,
		LifecycleState: "deleted", Health: "absent",
	}
}

func dependencyHasCode(err error, service string, code string) bool {
	var failure *ports.DependencyError
	return errors.As(err, &failure) && failure.Service == service && failure.Code == code
}

func validateDeleteAgentInput(input DeleteAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) {
		return fmt.Errorf("%w: Agent delete input", ErrInvalidInput)
	}
	return nil
}

func deleteAgentFingerprint(input DeleteAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID string
		AgentID   string
	}{RequestID: input.RequestID, AgentID: input.AgentID})
}

func deleteAgentResult(state ports.AgentDeleteState) DeleteAgentResult {
	return DeleteAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
