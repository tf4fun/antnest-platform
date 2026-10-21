package monitor

import (
	"context"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/diagnostics"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func (r *Runner) prune(ctx context.Context, pruner repository.ObservationPruner, epoch repository.ObservationEpoch, interval time.Duration) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		count, err := pruner.PruneObservationBatch(ctx, epoch)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, repository.ErrLeadershipLost) {
			return err
		}
		if err != nil {
			r.logger.WarnContext(ctx, "observation retention cleanup failed",
				"component", "observation_pruner", "result", "retrying",
				"error_class", "observation_prune_failed", "error", diagnostics.Message(err))
		} else if count > 0 {
			// Each batch is independently committed. Cancellation is observed
			// before starting the next batch, including during incident bursts.
			continue
		}
		if !wait(ctx, interval) {
			return nil
		}
	}
}
