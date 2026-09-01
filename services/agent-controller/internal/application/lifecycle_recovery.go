package application

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type LifecycleOperationResumer interface {
	ResumeLifecycleOperation(
		context.Context, ports.LifecycleOperationRecord,
	) (LifecycleRecoveryResult, error)
}

type LifecycleRecoveryResult struct {
	Phase      domain.OperationPhase
	State      domain.OperationState
	Progressed bool
	Terminal   bool
}

type LifecycleRecoveryInstrumentation func(
	context.Context,
	ports.LifecycleRecoveryClaim,
	func(context.Context, string) (LifecycleRecoveryResult, error),
) (LifecycleRecoveryResult, error)

type LifecycleRecoveryWorkerConfig struct {
	WorkerID       string
	PollInterval   time.Duration
	StaleAfter     time.Duration
	AttemptTimeout time.Duration
	LeaseDuration  time.Duration
	RetryMax       time.Duration
}

type LifecycleRecoveryWorker struct {
	store           ports.LifecycleRecoveryStore
	resumer         LifecycleOperationResumer
	instrumentation LifecycleRecoveryInstrumentation
	config          LifecycleRecoveryWorkerConfig
}

func NewLifecycleRecoveryWorker(
	store ports.LifecycleRecoveryStore,
	resumer LifecycleOperationResumer,
	instrumentation LifecycleRecoveryInstrumentation,
	config LifecycleRecoveryWorkerConfig,
) (*LifecycleRecoveryWorker, error) {
	if store == nil || resumer == nil || strings.TrimSpace(config.WorkerID) == "" ||
		config.PollInterval <= 0 || config.StaleAfter <= 0 || config.AttemptTimeout <= 0 ||
		config.LeaseDuration <= config.AttemptTimeout || config.StaleAfter < config.LeaseDuration ||
		config.RetryMax < config.PollInterval {
		return nil, fmt.Errorf("invalid lifecycle recovery worker configuration")
	}
	if instrumentation == nil {
		instrumentation = func(
			ctx context.Context,
			_ ports.LifecycleRecoveryClaim,
			resume func(context.Context, string) (LifecycleRecoveryResult, error),
		) (LifecycleRecoveryResult, error) {
			return resume(ctx, "")
		}
	}
	return &LifecycleRecoveryWorker{
		store: store, resumer: resumer,
		instrumentation: instrumentation, config: config,
	}, nil
}

func (worker *LifecycleRecoveryWorker) Run(ctx context.Context) error {
	for {
		processed, err := worker.RunOnce(ctx)
		if err != nil {
			if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
				return nil
			}
			return err
		}
		if processed {
			continue
		}
		timer := time.NewTimer(worker.config.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func (worker *LifecycleRecoveryWorker) RunOnce(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	claim, found, err := worker.store.ClaimLifecycleRecovery(ctx, ports.ClaimLifecycleRecovery{
		WorkerID: worker.config.WorkerID, StaleAfter: worker.config.StaleAfter,
		LeaseDuration: worker.config.LeaseDuration,
	})
	if err != nil || !found {
		return false, err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, worker.config.AttemptTimeout)
	result, attemptErr := worker.instrumentation(
		attemptCtx, claim,
		func(callCtx context.Context, traceParent string) (LifecycleRecoveryResult, error) {
			if err := worker.store.StartLifecycleRecoveryAttempt(
				callCtx, ports.StartLifecycleRecoveryAttempt{
					RequestID: claim.Operation.RequestID, WorkerID: claim.WorkerID,
					Attempt: claim.Attempt, TraceParent: traceParent,
				},
			); err != nil {
				return LifecycleRecoveryResult{}, err
			}
			callCtx = ports.WithLifecycleRecoveryToken(callCtx, ports.LifecycleRecoveryToken{
				RequestID: claim.Operation.RequestID, WorkerID: claim.WorkerID,
				Attempt: claim.Attempt,
			})
			return worker.resumer.ResumeLifecycleOperation(callCtx, claim.Operation)
		},
	)
	cancel()
	if ctx.Err() != nil {
		return true, ctx.Err()
	}
	if errors.Is(attemptErr, ports.ErrLifecycleRecoveryClaimLost) {
		return true, nil
	}
	if result.Terminal {
		return true, nil
	}
	if attemptErr != nil && !retryableLifecycleRecoveryError(attemptErr) {
		return true, fmt.Errorf("resume lifecycle operation %s: %w", claim.Operation.RequestID, attemptErr)
	}
	failed := attemptErr != nil && !errors.Is(attemptErr, ports.ErrConcurrentChange) &&
		!result.Progressed
	delay := worker.config.PollInterval
	if failed {
		delay = lifecycleRecoveryBackoff(
			worker.config.PollInterval, worker.config.RetryMax,
			claim.ConsecutiveFailures,
		)
	}
	if err := worker.store.ReleaseLifecycleRecoveryClaim(
		ctx, ports.ReleaseLifecycleRecoveryClaim{
			RequestID: claim.Operation.RequestID, WorkerID: claim.WorkerID,
			Attempt: claim.Attempt, Failed: failed, RetryAfter: delay,
		},
	); err != nil {
		if errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
			return true, nil
		}
		return true, err
	}
	return true, nil
}

func retryableLifecycleRecoveryError(err error) bool {
	return errors.Is(err, ErrDependencyUnavailable) ||
		errors.Is(err, ports.ErrConcurrentChange) ||
		errors.Is(err, context.DeadlineExceeded)
}

func lifecycleRecoveryBackoff(base time.Duration, maximum time.Duration, failures int64) time.Duration {
	delay := base
	for range failures {
		if delay >= maximum || delay > maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

func (service *LifecycleService) ResumeLifecycleOperation(
	ctx context.Context, operation ports.LifecycleOperationRecord,
) (LifecycleRecoveryResult, error) {
	token, ok := ports.LifecycleRecoveryTokenFromContext(ctx)
	if !ok || token.RequestID != operation.RequestID {
		return LifecycleRecoveryResult{}, ports.ErrLifecycleRecoveryClaimLost
	}
	if operation.State != domain.OperationRunning {
		return lifecycleRecoveryResult(operation, lifecycleOperationView(operation)), nil
	}
	switch operation.Kind {
	case domain.OperationCreate:
		state, found, err := service.store.ReplayAgentCreate(
			ctx, operation.RequestID, operation.RequestFingerprint,
		)
		if err != nil || !found {
			return LifecycleRecoveryResult{}, lifecycleRecoveryReplayError("create", found, err)
		}
		result, err := service.continueAgentCreate(ctx, state)
		return lifecycleRecoveryResult(operation, result.Operation), err
	case domain.OperationRebuild:
		state, found, err := service.store.ReplayAgentRebuild(
			ctx, operation.RequestID, operation.RequestFingerprint,
		)
		if err != nil || !found {
			return LifecycleRecoveryResult{}, lifecycleRecoveryReplayError("rebuild", found, err)
		}
		result, err := service.continueAgentRebuild(ctx, state)
		return lifecycleRecoveryResult(operation, result.Operation), err
	case domain.OperationDisable:
		state, found, err := service.store.ReplayAgentDisable(
			ctx, operation.RequestID, operation.RequestFingerprint,
		)
		if err != nil || !found {
			return LifecycleRecoveryResult{}, lifecycleRecoveryReplayError("disable", found, err)
		}
		result, err := service.continueAgentDisable(ctx, state)
		return lifecycleRecoveryResult(operation, result.Operation), err
	case domain.OperationEnable:
		state, found, err := service.store.ReplayAgentEnable(
			ctx, operation.RequestID, operation.RequestFingerprint,
		)
		if err != nil || !found {
			return LifecycleRecoveryResult{}, lifecycleRecoveryReplayError("enable", found, err)
		}
		result, err := service.continueAgentEnable(ctx, state)
		return lifecycleRecoveryResult(operation, result.Operation), err
	case domain.OperationDelete:
		state, found, err := service.store.ReplayAgentDelete(
			ctx, operation.RequestID, operation.RequestFingerprint,
		)
		if err != nil || !found {
			return LifecycleRecoveryResult{}, lifecycleRecoveryReplayError("delete", found, err)
		}
		result, err := service.continueAgentDelete(ctx, state)
		return lifecycleRecoveryResult(operation, result.Operation), err
	default:
		return LifecycleRecoveryResult{}, fmt.Errorf("unsupported lifecycle recovery kind %q", operation.Kind)
	}
}

func lifecycleRecoveryResult(
	before ports.LifecycleOperationRecord, after OperationView,
) LifecycleRecoveryResult {
	if after.RequestID == "" {
		after = lifecycleOperationView(before)
	}
	return LifecycleRecoveryResult{
		Phase: after.Phase, State: after.State,
		Progressed: after.Phase != before.Phase || after.State != before.State,
		Terminal:   after.State != "" && after.State != domain.OperationRunning,
	}
}

func lifecycleRecoveryReplayError(kind string, found bool, err error) error {
	if err != nil {
		return fmt.Errorf("replay %s lifecycle recovery: %w", kind, err)
	}
	if !found {
		return fmt.Errorf("replay %s lifecycle recovery: %w", kind, ports.ErrNotFound)
	}
	return nil
}

func lifecycleOperationReservedForRecovery(
	ctx context.Context, operation ports.LifecycleOperationRecord,
) bool {
	if operation.RecoveryOwner == "" {
		return false
	}
	token, ok := ports.LifecycleRecoveryTokenFromContext(ctx)
	return !ok || token.RequestID != operation.RequestID ||
		token.WorkerID != operation.RecoveryOwner || token.Attempt != operation.Attempt
}

var _ LifecycleOperationResumer = (*LifecycleService)(nil)
