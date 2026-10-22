package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// The worker resumes only committed starts. Current policy, ACP observations
// and business admission are deliberately absent from this dependency boundary.
type RuntimeBarrierRecoveryStartStore interface {
	ListPendingRuntimeBarrierRecoveryStarts(context.Context, string, int) ([]ports.RuntimeBarrierRecoveryReceipt, error)
	ConfirmRuntimeBarrierRecoveryStarted(context.Context, string, string) error
}

type RuntimeBarrierRecoveryStarter interface {
	EnsureRuntimeBarrierRecoveryStarted(context.Context, ports.RuntimeBarrierRecoveryReceipt) error
}

type RuntimeBarrierRecoveryStartSchedule struct {
	PollInterval time.Duration
	RoundTimeout time.Duration
	BatchSize    int
}

type RuntimeBarrierRecoveryStartWorker struct {
	store          RuntimeBarrierRecoveryStartStore
	starter        RuntimeBarrierRecoveryStarter
	schedule       RuntimeBarrierRecoveryStartSchedule
	logger         *slog.Logger
	gate           chan struct{}
	afterRequestID string
}

func NewRuntimeBarrierRecoveryStartWorker(store RuntimeBarrierRecoveryStartStore, starter RuntimeBarrierRecoveryStarter,
	schedule RuntimeBarrierRecoveryStartSchedule, logger *slog.Logger,
) (*RuntimeBarrierRecoveryStartWorker, error) {
	if store == nil || starter == nil || schedule.PollInterval <= 0 || schedule.RoundTimeout <= 0 ||
		schedule.BatchSize < 1 || schedule.BatchSize > 1000 {
		return nil, fmt.Errorf("runtime barrier recovery start dependencies or schedule are invalid")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &RuntimeBarrierRecoveryStartWorker{store: store, starter: starter, schedule: schedule,
		logger: logger, gate: make(chan struct{}, 1)}, nil
}

func (worker *RuntimeBarrierRecoveryStartWorker) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil {
			worker.logger.WarnContext(ctx, "Runtime barrier recovery start synchronization failed",
				"component", "runtime_barrier_recovery_start", "error_class", "recovery_start_failed")
		}
		if !waitPublication(ctx, worker.schedule.PollInterval, nil) {
			return
		}
	}
}

// RunOnce consumes one page using one deadline, including any wait for this
// worker's cursor gate. Calls remain synchronous: a dependency that returns
// late after cancellation must actually settle before this round can return.
func (worker *RuntimeBarrierRecoveryStartWorker) RunOnce(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, worker.schedule.RoundTimeout)
	defer cancel()
	select {
	case worker.gate <- struct{}{}:
		defer func() { <-worker.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	page, err := worker.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, worker.afterRequestID, worker.schedule.BatchSize)
	if cancelled := ctx.Err(); cancelled != nil {
		return errors.Join(err, cancelled)
	}
	if err != nil {
		return fmt.Errorf("list pending Runtime barrier recovery starts: %w", err)
	}
	if len(page) > worker.schedule.BatchSize {
		return fmt.Errorf("%w: oversized Runtime barrier recovery start page", ErrQueryContract)
	}
	previous := worker.afterRequestID
	for _, receipt := range page {
		id := receipt.Command.RequestID
		if !domain.ValidRuntimeBarrierPolicyIdentifier(id) || id <= previous {
			return fmt.Errorf("%w: invalid Runtime barrier recovery start cursor", ErrQueryContract)
		}
		previous = id
	}

	var failure error
	for _, receipt := range page {
		if err := ctx.Err(); err != nil {
			return errors.Join(failure, err)
		}
		err := worker.starter.EnsureRuntimeBarrierRecoveryStarted(ctx, receipt)
		// An attempted failure must not starve later entries. Unattempted entries
		// retain their position if cancellation interrupts a partially read page.
		worker.afterRequestID = receipt.Command.RequestID
		if err != nil {
			failure = errors.Join(failure, fmt.Errorf("ensure original Runtime barrier recovery start: %w", err))
		}
		if cancelled := ctx.Err(); cancelled != nil {
			return errors.Join(failure, cancelled)
		}
		if err != nil {
			continue
		}
		if err := worker.store.ConfirmRuntimeBarrierRecoveryStarted(ctx, receipt.Command.RequestID, receipt.RequestFingerprint); err != nil {
			failure = errors.Join(failure, fmt.Errorf("confirm original Runtime barrier recovery start: %w", err))
		}
		if cancelled := ctx.Err(); cancelled != nil {
			// The confirmation may have committed. Preserve the unknown result;
			// the next scan observes durable state without inventing a rollback.
			return errors.Join(failure, cancelled)
		}
	}
	if len(page) < worker.schedule.BatchSize {
		worker.afterRequestID = ""
	}
	return failure
}
