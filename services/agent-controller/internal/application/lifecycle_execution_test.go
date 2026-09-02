package application

import (
	"context"
	"errors"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const maximumLifecycleTestSteps = 32

// These helpers exercise the durable phase machine without putting synchronous
// Saga execution back into the production command path.
func executeCreateForTest(
	service *LifecycleService, ctx context.Context, input CreateAgentInput,
) (CreateAgentResult, error) {
	result, err := service.CreateAgent(ctx, input)
	if err != nil || result.Operation.State != domain.OperationRunning {
		return result, err
	}
	fingerprint, err := createAgentFingerprint(input)
	if err != nil {
		return CreateAgentResult{}, err
	}
	for range maximumLifecycleTestSteps {
		state, found, replayErr := service.store.ReplayAgentCreate(ctx, input.RequestID, fingerprint)
		if replayErr != nil || !found {
			return CreateAgentResult{}, lifecycleTestReplayError("create", found, replayErr)
		}
		if state.Operation.State != domain.OperationRunning {
			return createAgentResult(state), nil
		}
		phase := state.Operation.Phase
		next, stepErr := service.stepAgentCreate(ctx, state)
		result = createAgentResult(next)
		if errors.Is(stepErr, ports.ErrConcurrentChange) {
			continue
		}
		if stepErr != nil || result.Operation.State != domain.OperationRunning ||
			result.Operation.Phase == phase {
			return result, stepErr
		}
	}
	return result, fmt.Errorf("create lifecycle exceeded %d test steps", maximumLifecycleTestSteps)
}

func executeRebuildForTest(
	service *LifecycleService, ctx context.Context, input RebuildAgentInput,
) (RebuildAgentResult, error) {
	result, err := service.RebuildAgent(ctx, input)
	if err != nil || result.Operation.State != domain.OperationRunning {
		return result, err
	}
	fingerprint, err := rebuildAgentFingerprint(input)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	for range maximumLifecycleTestSteps {
		state, found, replayErr := service.store.ReplayAgentRebuild(ctx, input.RequestID, fingerprint)
		if replayErr != nil || !found {
			return RebuildAgentResult{}, lifecycleTestReplayError("rebuild", found, replayErr)
		}
		if state.Operation.State != domain.OperationRunning {
			return rebuildAgentResult(state), nil
		}
		phase := state.Operation.Phase
		next, stepErr := service.stepAgentRebuild(ctx, state)
		result = rebuildAgentResult(next)
		if errors.Is(stepErr, ports.ErrConcurrentChange) {
			continue
		}
		if stepErr != nil || result.Operation.State != domain.OperationRunning ||
			result.Operation.Phase == phase {
			return result, stepErr
		}
	}
	return result, fmt.Errorf("rebuild lifecycle exceeded %d test steps", maximumLifecycleTestSteps)
}

func executeDisableForTest(
	service *LifecycleService, ctx context.Context, input DisableAgentInput,
) (DisableAgentResult, error) {
	result, err := service.DisableAgent(ctx, input)
	if err != nil || result.Operation.State != domain.OperationRunning {
		return result, err
	}
	fingerprint, err := disableAgentFingerprint(input)
	if err != nil {
		return DisableAgentResult{}, err
	}
	for range maximumLifecycleTestSteps {
		state, found, replayErr := service.store.ReplayAgentDisable(ctx, input.RequestID, fingerprint)
		if replayErr != nil || !found {
			return DisableAgentResult{}, lifecycleTestReplayError("disable", found, replayErr)
		}
		if state.Operation.State != domain.OperationRunning {
			return disableAgentResult(state), nil
		}
		phase := state.Operation.Phase
		next, stepErr := service.stepAgentDisable(ctx, state)
		result = disableAgentResult(next)
		if errors.Is(stepErr, ports.ErrConcurrentChange) {
			continue
		}
		if stepErr != nil || result.Operation.State != domain.OperationRunning ||
			result.Operation.Phase == phase {
			return result, stepErr
		}
	}
	return result, fmt.Errorf("disable lifecycle exceeded %d test steps", maximumLifecycleTestSteps)
}

func executeEnableForTest(
	service *LifecycleService, ctx context.Context, input EnableAgentInput,
) (EnableAgentResult, error) {
	result, err := service.EnableAgent(ctx, input)
	if err != nil || result.Operation.State != domain.OperationRunning {
		return result, err
	}
	fingerprint, err := enableAgentFingerprint(input)
	if err != nil {
		return EnableAgentResult{}, err
	}
	for range maximumLifecycleTestSteps {
		state, found, replayErr := service.store.ReplayAgentEnable(ctx, input.RequestID, fingerprint)
		if replayErr != nil || !found {
			return EnableAgentResult{}, lifecycleTestReplayError("enable", found, replayErr)
		}
		if state.Operation.State != domain.OperationRunning {
			return enableAgentResult(state), nil
		}
		phase := state.Operation.Phase
		next, stepErr := service.stepAgentEnable(ctx, state)
		result = enableAgentResult(next)
		if errors.Is(stepErr, ports.ErrConcurrentChange) {
			continue
		}
		if stepErr != nil || result.Operation.State != domain.OperationRunning ||
			result.Operation.Phase == phase {
			return result, stepErr
		}
	}
	return result, fmt.Errorf("enable lifecycle exceeded %d test steps", maximumLifecycleTestSteps)
}

func executeDeleteForTest(
	service *LifecycleService, ctx context.Context, input DeleteAgentInput,
) (DeleteAgentResult, error) {
	result, err := service.DeleteAgent(ctx, input)
	if err != nil || result.Operation.State != domain.OperationRunning {
		return result, err
	}
	fingerprint, err := deleteAgentFingerprint(input)
	if err != nil {
		return DeleteAgentResult{}, err
	}
	for range maximumLifecycleTestSteps {
		state, found, replayErr := service.store.ReplayAgentDelete(ctx, input.RequestID, fingerprint)
		if replayErr != nil || !found {
			return DeleteAgentResult{}, lifecycleTestReplayError("delete", found, replayErr)
		}
		if state.Operation.State != domain.OperationRunning {
			return deleteAgentResult(state), nil
		}
		phase := state.Operation.Phase
		next, stepErr := service.stepAgentDelete(ctx, state)
		result = deleteAgentResult(next)
		if errors.Is(stepErr, ports.ErrConcurrentChange) {
			continue
		}
		if stepErr != nil || result.Operation.State != domain.OperationRunning ||
			result.Operation.Phase == phase {
			return result, stepErr
		}
	}
	return result, fmt.Errorf("delete lifecycle exceeded %d test steps", maximumLifecycleTestSteps)
}

func lifecycleTestReplayError(kind string, found bool, err error) error {
	if err != nil {
		return fmt.Errorf("replay %s lifecycle in test: %w", kind, err)
	}
	if !found {
		return fmt.Errorf("replay %s lifecycle in test: operation disappeared", kind)
	}
	return nil
}
