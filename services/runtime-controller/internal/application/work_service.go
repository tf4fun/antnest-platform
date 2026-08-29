package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

var (
	ErrRuntimeUnavailable = errors.New("runtime is not ready for work")
	ErrWorkEpochStale     = errors.New("work epoch is stale or exhausted")
)

type RuntimeWorkPort interface {
	BeginWork(context.Context, runtimecontracts.GenerationKey, runtimecontracts.BeginWorkInput) runtimecontracts.BeginWorkResult
	EndWork(context.Context, runtimecontracts.GenerationKey, runtimecontracts.EndWorkInput) runtimecontracts.EndWorkResult
	Exec(context.Context, runtimecontracts.GenerationKey, runtimecontracts.ExecInput) runtimecontracts.ExecResult
	ReadFile(context.Context, runtimecontracts.GenerationKey, runtimecontracts.ReadFileInput) runtimecontracts.ReadFileResult
	WriteFile(context.Context, runtimecontracts.GenerationKey, runtimecontracts.WriteFileInput) runtimecontracts.WriteFileResult
	EditFile(context.Context, runtimecontracts.GenerationKey, runtimecontracts.EditFileInput) runtimecontracts.EditFileResult
	ListDir(context.Context, runtimecontracts.GenerationKey, runtimecontracts.ListDirInput) runtimecontracts.ListDirResult
	CancelOperation(context.Context, runtimecontracts.GenerationKey, runtimecontracts.CancelOperationInput) runtimecontracts.CancelOperationResult
}

type WorkService struct {
	repository Repository
	executor   RuntimeWorkPort
	now        func() time.Time
}

func NewWorkService(repository Repository, executor RuntimeWorkPort) (*WorkService, error) {
	if repository == nil || executor == nil {
		return nil, fmt.Errorf("runtime repository and work executor are required")
	}
	return &WorkService{
		repository: repository, executor: executor,
		now: func() time.Time { return time.Now().UTC() },
	}, nil
}

func (s *WorkService) BeginWork(
	ctx context.Context, agentID string, input runtimecontracts.BeginWorkInput,
) (runtimecontracts.BeginWorkResult, error) {
	target, err := s.reserveWorkEpoch(ctx, agentID, input.WorkRef)
	if err != nil {
		return runtimecontracts.BeginWorkResult{}, err
	}
	result := s.executor.BeginWork(ctx, target, input)
	if result.Disposition == runtimecontracts.EffectNotStarted && result.Reason == "runtime_unavailable" {
		if err := s.releaseUndispatchedWork(ctx, agentID, target, input.WorkRef); err != nil {
			return runtimecontracts.BeginWorkResult{}, fmt.Errorf("release undispatched Work reservation: %w", err)
		}
	}
	return result, nil
}

func (s *WorkService) releaseUndispatchedWork(
	ctx context.Context,
	agentID string,
	target runtimecontracts.GenerationKey,
	work runtimecontracts.WorkRef,
) error {
	return s.repository.Transact(ctx, func(tx Transaction) error {
		generation, err := tx.GetGeneration(ctx, agentID, target.Generation)
		if err != nil {
			return err
		}
		if generation.RuntimeInstanceID != target.RuntimeInstanceID ||
			generation.LastWorkID != work.WorkID ||
			generation.LastWorkEpoch != work.WorkEpoch ||
			generation.LastWorkSessionID != work.WorkSessionID {
			return nil
		}
		expectedFloor := min(work.WorkEpoch+1, runtimecontracts.MaxWorkEpoch)
		if generation.WorkEpochFloor != expectedFloor {
			return nil
		}
		generation.WorkEpochFloor = work.WorkEpoch
		generation.LastWorkID = ""
		generation.LastWorkEpoch = 0
		generation.LastWorkSessionID = ""
		generation.ResourceVersion++
		generation.UpdatedAt = s.now()
		return tx.SaveGeneration(ctx, generation)
	})
}

func (s *WorkService) reserveWorkEpoch(
	ctx context.Context,
	agentID string,
	work runtimecontracts.WorkRef,
) (runtimecontracts.GenerationKey, error) {
	var target runtimecontracts.GenerationKey
	err := s.repository.Transact(ctx, func(tx Transaction) error {
		runtime, err := tx.GetRuntime(ctx, agentID)
		if err != nil {
			return err
		}
		if runtime.DesiredState != domain.DesiredActive || runtime.Status != domain.RuntimeReady ||
			runtime.DesiredGeneration == 0 || runtime.ObservedGeneration != runtime.DesiredGeneration {
			return ErrRuntimeUnavailable
		}
		generation, err := tx.GetGeneration(ctx, runtime.AgentID, runtime.DesiredGeneration)
		if err != nil {
			return err
		}
		if generation.Status != domain.GenerationReady {
			return ErrRuntimeUnavailable
		}
		target = runtimecontracts.GenerationKey{
			RuntimeInstanceID: generation.RuntimeInstanceID,
			Generation:        generation.Number,
		}
		if err := target.Validate(); err != nil {
			return fmt.Errorf("%w: %v", ErrRuntimeUnavailable, err)
		}
		if generation.LastWorkID == work.WorkID &&
			generation.LastWorkEpoch == work.WorkEpoch &&
			generation.LastWorkSessionID == work.WorkSessionID {
			return nil
		}
		floor := generation.WorkEpochFloor
		if floor == 0 {
			floor = 1
		}
		if work.WorkEpoch < floor ||
			(floor == runtimecontracts.MaxWorkEpoch && work.WorkEpoch == runtimecontracts.MaxWorkEpoch) {
			return ErrWorkEpochStale
		}
		generation.WorkEpochFloor = min(work.WorkEpoch+1, runtimecontracts.MaxWorkEpoch)
		generation.LastWorkID = work.WorkID
		generation.LastWorkEpoch = work.WorkEpoch
		generation.LastWorkSessionID = work.WorkSessionID
		generation.ResourceVersion++
		generation.UpdatedAt = s.now()
		return tx.SaveGeneration(ctx, generation)
	})
	if err != nil {
		return runtimecontracts.GenerationKey{}, err
	}
	return target, nil
}

func (s *WorkService) EndWork(
	ctx context.Context, agentID string, input runtimecontracts.EndWorkInput,
) (runtimecontracts.EndWorkResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.EndWorkResult{}, err
	}
	return s.executor.EndWork(ctx, target, input), nil
}

func (s *WorkService) Exec(
	ctx context.Context, agentID string, input runtimecontracts.ExecInput,
) (runtimecontracts.ExecResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.ExecResult{}, err
	}
	return s.executor.Exec(ctx, target, input), nil
}

func (s *WorkService) ReadFile(
	ctx context.Context, agentID string, input runtimecontracts.ReadFileInput,
) (runtimecontracts.ReadFileResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.ReadFileResult{}, err
	}
	return s.executor.ReadFile(ctx, target, input), nil
}

func (s *WorkService) WriteFile(
	ctx context.Context, agentID string, input runtimecontracts.WriteFileInput,
) (runtimecontracts.WriteFileResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.WriteFileResult{}, err
	}
	return s.executor.WriteFile(ctx, target, input), nil
}

func (s *WorkService) EditFile(
	ctx context.Context, agentID string, input runtimecontracts.EditFileInput,
) (runtimecontracts.EditFileResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.EditFileResult{}, err
	}
	return s.executor.EditFile(ctx, target, input), nil
}

func (s *WorkService) ListDir(
	ctx context.Context, agentID string, input runtimecontracts.ListDirInput,
) (runtimecontracts.ListDirResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.ListDirResult{}, err
	}
	return s.executor.ListDir(ctx, target, input), nil
}

func (s *WorkService) CancelOperation(
	ctx context.Context, agentID string, input runtimecontracts.CancelOperationInput,
) (runtimecontracts.CancelOperationResult, error) {
	target, err := s.executionTarget(ctx, agentID)
	if err != nil {
		return runtimecontracts.CancelOperationResult{}, err
	}
	return s.executor.CancelOperation(ctx, target, input), nil
}

func (s *WorkService) executionTarget(
	ctx context.Context, agentID string,
) (runtimecontracts.GenerationKey, error) {
	runtime, err := s.repository.GetRuntime(ctx, agentID)
	if err != nil {
		return runtimecontracts.GenerationKey{}, err
	}
	if runtime.DesiredState != domain.DesiredActive || runtime.Status != domain.RuntimeReady ||
		runtime.DesiredGeneration == 0 || runtime.ObservedGeneration != runtime.DesiredGeneration {
		return runtimecontracts.GenerationKey{}, ErrRuntimeUnavailable
	}
	generation, err := s.repository.GetGeneration(ctx, runtime.AgentID, runtime.DesiredGeneration)
	if err != nil {
		return runtimecontracts.GenerationKey{}, err
	}
	if generation.Status != domain.GenerationReady {
		return runtimecontracts.GenerationKey{}, ErrRuntimeUnavailable
	}
	target := runtimecontracts.GenerationKey{
		RuntimeInstanceID: generation.RuntimeInstanceID,
		Generation:        generation.Number,
	}
	if err := target.Validate(); err != nil {
		return runtimecontracts.GenerationKey{}, fmt.Errorf("%w: %v", ErrRuntimeUnavailable, err)
	}
	return target, nil
}
