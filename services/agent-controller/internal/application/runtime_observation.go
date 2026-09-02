package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const runtimeObservationPageSize = 500

var runtimeObservationTracer = otel.Tracer("soft/antnest-platform/agent-controller/runtime-observation")

type RuntimeObservationWorker struct {
	source       ports.RuntimeObservationSource
	store        ports.RuntimeObservationStore
	pollInterval time.Duration
	logger       *slog.Logger
}

func NewRuntimeObservationWorker(
	source ports.RuntimeObservationSource,
	store ports.RuntimeObservationStore,
	pollInterval time.Duration,
	logger *slog.Logger,
) (*RuntimeObservationWorker, error) {
	if source == nil || store == nil || pollInterval <= 0 {
		return nil, fmt.Errorf("runtime observation worker dependencies are incomplete")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &RuntimeObservationWorker{
		source: source, store: store, pollInterval: pollInterval, logger: logger,
	}, nil
}

func (worker *RuntimeObservationWorker) Run(ctx context.Context) {
	ticker := time.NewTicker(worker.pollInterval)
	defer ticker.Stop()
	for {
		if err := worker.synchronize(ctx); err != nil && ctx.Err() == nil {
			worker.logger.WarnContext(ctx, "Runtime observation synchronization failed",
				"component", "runtime_observation", "error_class", "runtime_observation_sync_failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (worker *RuntimeObservationWorker) synchronize(ctx context.Context) (resultErr error) {
	ctx, span := runtimeObservationTracer.Start(
		ctx, "agent_controller.runtime_observation.synchronize", trace.WithSpanKind(trace.SpanKindConsumer),
	)
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, "Runtime observation synchronization failed")
		}
		span.End()
	}()
	cursor, err := worker.store.GetRuntimeObservationCursor(ctx)
	if err != nil {
		return fmt.Errorf("read Runtime observation cursor: %w", err)
	}
	if !cursor.Initialized {
		runtimes, listErr := worker.source.ListRuntimes(ctx)
		if listErr != nil {
			return fmt.Errorf("bootstrap Runtime observations: %w", listErr)
		}
		if err := worker.store.InitializeRuntimeObservationCursor(ctx, runtimes); err != nil {
			return fmt.Errorf("initialize Runtime observation cursor: %w", err)
		}
		cursor.Initialized = true
	}
	for {
		page, listErr := worker.source.ListRuntimeObservations(
			ctx, cursor.Sequence, runtimeObservationPageSize,
		)
		if listErr != nil {
			var expired *ports.RuntimeObservationCursorExpiredError
			if !errors.As(listErr, &expired) {
				return fmt.Errorf("list Runtime observations: %w", listErr)
			}
			runtimes, runtimesErr := worker.source.ListRuntimes(ctx)
			if runtimesErr != nil {
				return fmt.Errorf("reconcile expired Runtime observation cursor: %w", runtimesErr)
			}
			if err := worker.store.ResetRuntimeObservationCursor(
				ctx, runtimes, expired.ResetSequence,
			); err != nil {
				return fmt.Errorf("reset Runtime observation cursor: %w", err)
			}
			cursor.Sequence = expired.ResetSequence
			continue
		}
		for _, observation := range page.Observations {
			if observation.Sequence <= cursor.Sequence {
				continue
			}
			if err := worker.store.ApplyRuntimeObservation(ctx, observation); err != nil {
				return fmt.Errorf("apply Runtime observation %d: %w", observation.Sequence, err)
			}
			cursor.Sequence = observation.Sequence
		}
		if page.NextSequence != cursor.Sequence {
			return fmt.Errorf("runtime observation page cursor is inconsistent")
		}
		if len(page.Observations) < runtimeObservationPageSize {
			return nil
		}
	}
}

var _ interface{ Run(context.Context) } = (*RuntimeObservationWorker)(nil)
