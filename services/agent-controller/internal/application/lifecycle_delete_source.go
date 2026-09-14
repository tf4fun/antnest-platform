package application

import (
	"context"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (service *LifecycleService) advanceDeleteFence(ctx context.Context, state ports.AgentDeleteState, attachment *ports.NetworkAttachment) (ports.AgentDeleteState, error) {
	unresolved := state.Operation.SourceRuntimeRevision == "" && !state.Operation.SourceRuntimeAbsent
	if unresolved {
		resolved, ready, err := service.resolveDeleteRuntime(ctx, state)
		if err != nil || !ready {
			return state, err
		}
		state = resolved
	}
	next := domain.PhaseRuntimeDelete
	if state.Operation.SourceRuntimeAbsent {
		if !validRuntimeAbsenceProof(state.Operation.SourceRuntimeAbsenceProof) {
			return state, fmt.Errorf("%w: Runtime absence is unproven", ErrDependencyUnavailable)
		}
		next = domain.PhaseNetworkRelease
	}
	input := deleteAdvanceInput(state, domain.PhaseNetworkFence, next, service.clock.Now())
	input.NetworkAttachment = attachment
	if unresolved {
		input.SourceRuntimeInspection = state.Operation.SourceRuntimeInspection
		input.SourceRuntimeAbsenceProof = state.Operation.SourceRuntimeAbsenceProof
	}
	return service.store.AdvanceAgentDelete(ctx, input)
}

func (service *LifecycleService) resolveDeleteRuntime(ctx context.Context, state ports.AgentDeleteState) (ports.AgentDeleteState, bool, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
		state.Operation.SourceRuntimeAbsent = true
		state.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{Reason: "runtime_not_found", ObservedAt: service.clock.Now()}
		return state, true, nil
	}
	if err != nil || inspection.AgentID != state.Agent.AgentID || inspection.RuntimeRevision == "" {
		return state, false, fmt.Errorf("%w: Runtime cleanup source inspection", ErrDependencyUnavailable)
	}
	if runtimeInspectionProvesDeleted(state.Agent.AgentID, inspection) {
		state.Operation.SourceRuntimeAbsent = true
		state.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{
			Reason: "runtime_deleted", RuntimeRevision: inspection.RuntimeRevision, ObservedAt: service.clock.Now(),
		}
		return state, true, nil
	}
	switch inspection.LifecycleState {
	case "provisioned", "disabled", "failed":
		state.Operation.SourceRuntimeRevision = inspection.RuntimeRevision
		state.Operation.SourceRuntimeInspection = &inspection
		return state, true, nil
	default:
		return state, false, nil
	}
}
