package application

import (
	"context"
	"fmt"
	"slices"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func (service *LifecycleService) ReplayCreateAgent(ctx context.Context, input CreateAgentInput) (CreateAgentResult, bool, error) {
	if err := validateCreateAgentInput(input); err != nil {
		return CreateAgentResult{}, false, err
	}
	fingerprint, err := createAgentFingerprint(input)
	if err != nil {
		return CreateAgentResult{}, false, err
	}
	state, found, err := service.store.ReplayAgentCreate(ctx, input.RequestID, fingerprint)
	if err != nil || !found {
		return CreateAgentResult{}, found, err
	}
	if state.Agent.OrganizationID != input.OrganizationID {
		return CreateAgentResult{}, false, ErrAgentNotFound
	}
	return createAgentResult(state), true, nil
}

// AdvanceAgentCreate executes one business stage; the workflow engine owns retries.
func (service *LifecycleService) AdvanceAgentCreate(ctx context.Context, input CreateAgentInput, phase domain.OperationPhase) (OperationView, error) {
	fingerprint, err := createAgentFingerprint(input)
	if err != nil {
		return OperationView{}, err
	}
	state, found, err := service.store.ReplayAgentCreate(ctx, input.RequestID, fingerprint)
	if err != nil || !found {
		return OperationView{}, lifecycleReplayError("create", found, err)
	}
	plan, err := domain.OperationPlan(domain.OperationCreate)
	if err != nil {
		return OperationView{}, err
	}
	expected := slices.Index(plan, phase)
	current := slices.Index(plan, state.Operation.Phase)
	if expected < 0 || (state.Operation.State == domain.OperationRunning && current < expected) {
		return OperationView{}, fmt.Errorf("%w: create phase %s is not ready", ErrInvalidInput, phase)
	}
	if state.Operation.State != domain.OperationRunning || current > expected {
		// A retry after the phase transaction committed must not repeat its side effects.
		if state.Operation.State == domain.OperationCompleted || state.Operation.State == domain.OperationFailed {
			if err := service.releasePreparedSkills(ctx, input.RequestID, fingerprint); err != nil {
				return OperationView{}, err
			}
		}
		return lifecycleOperationView(state.Operation), nil
	}
	next, err := service.stepAgentCreate(ctx, state)
	if err != nil {
		return OperationView{}, err
	}
	if next.Operation.State == domain.OperationRunning && next.Operation.Phase == phase {
		return OperationView{}, fmt.Errorf("%w: Runtime effect is still pending", ErrDependencyUnavailable)
	}
	if next.Operation.State == domain.OperationCompleted || next.Operation.State == domain.OperationFailed {
		if err := service.releasePreparedSkills(ctx, input.RequestID, fingerprint); err != nil {
			return OperationView{}, err
		}
	}
	return lifecycleOperationView(next.Operation), nil
}
