package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// FailedCreateGCWorker periodically admits eligible failed creates into the
// normal durable delete lifecycle. Each sweep freezes one cutoff so per-item
// admission and repository rechecks compare against the same instant.
type FailedCreateGCWorker struct {
	store    ports.FailedCreateGCStore
	commands interface {
		DeleteFailedCreate(context.Context, ports.FailedCreateGCCandidate, time.Time) error
	}
	clock  ports.Clock
	ttl    time.Duration
	limit  int
	logger *slog.Logger
}

func NewFailedCreateGCWorker(
	store ports.FailedCreateGCStore,
	commands interface {
		DeleteFailedCreate(context.Context, ports.FailedCreateGCCandidate, time.Time) error
	},
	clock ports.Clock, ttl time.Duration, limit int,
) (*FailedCreateGCWorker, error) {
	if store == nil || commands == nil || clock == nil {
		return nil, fmt.Errorf("%w: failed-create GC dependencies", ErrInvalidInput)
	}
	if ttl < 0 {
		return nil, fmt.Errorf("%w: failed-create GC TTL", ErrInvalidInput)
	}
	if limit < 1 || limit > 500 {
		return nil, fmt.Errorf("%w: failed-create GC limit", ErrInvalidInput)
	}
	return &FailedCreateGCWorker{
		store: store, commands: commands, clock: clock,
		ttl: ttl, limit: limit, logger: slog.Default(),
	}, nil
}

// RunOnce executes a single sweep. A disabled TTL returns without touching the
// store. Candidate failures are joined after every item had its turn so one
// bad candidate cannot starve later deletions.
func (worker *FailedCreateGCWorker) RunOnce(ctx context.Context) error {
	if worker.ttl == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	cutoff := worker.clock.Now().Add(-worker.ttl)
	listCtx, done := context.WithTimeout(ctx, 5*time.Second)
	candidates, err := worker.store.ListFailedCreateGCCandidates(listCtx, cutoff, worker.limit)
	done()
	if err != nil {
		return fmt.Errorf("list failed-create GC candidates: %w", err)
	}
	var failures []error
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		itemCtx, done := context.WithTimeout(ctx, 5*time.Second)
		err := worker.commands.DeleteFailedCreate(itemCtx, candidate, cutoff)
		done()
		if err != nil {
			failures = append(failures, fmt.Errorf("delete failed create %s: %w", candidate.AgentID, err))
		}
	}
	return errors.Join(failures...)
}

// Run sweeps immediately then on the configured interval until the context is
// done. Sweep failures are logged, not fatal.
func (worker *FailedCreateGCWorker) Run(ctx context.Context, interval time.Duration) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := worker.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			worker.logger.WarnContext(ctx, "failed-create GC sweep failed", "error_class", "failed_create_gc_sweep_failed")
		}
		if interval <= 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
