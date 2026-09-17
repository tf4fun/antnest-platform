package application

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionOrganizationSource interface {
	ListExecutionOrganizations(context.Context, string, int) ([]string, error)
}

type ExecutionSnapshotPublisher interface {
	Publish(context.Context, string) (ports.ExecutionAcknowledgement, error)
}

type ExecutionPublicationSchedule struct {
	ResyncInterval   time.Duration
	RetryInterval    time.Duration
	MaxRetryInterval time.Duration
	RequestTimeout   time.Duration
}

type ExecutionPublicationWorker struct {
	source    ExecutionOrganizationSource
	publisher ExecutionSnapshotPublisher
	schedule  ExecutionPublicationSchedule
	logger    *slog.Logger
	tracer    trace.Tracer
	wake      chan struct{}
	mu        sync.Mutex
	pending   map[string]trace.SpanContext
	closed    bool
}

func NewExecutionPublicationWorker(source ExecutionOrganizationSource, publisher ExecutionSnapshotPublisher,
	schedule ExecutionPublicationSchedule, logger *slog.Logger,
) (*ExecutionPublicationWorker, error) {
	if source == nil || publisher == nil || schedule.ResyncInterval <= 0 || schedule.RetryInterval <= 0 ||
		schedule.MaxRetryInterval < schedule.RetryInterval || schedule.RequestTimeout <= 0 {
		return nil, fmt.Errorf("execution publication worker dependencies or schedule are invalid")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &ExecutionPublicationWorker{source: source, publisher: publisher, schedule: schedule,
		logger: logger, tracer: otel.Tracer("soft/antnest-platform/agent-controller/execution-publication"),
		wake: make(chan struct{}, 1), pending: make(map[string]trace.SpanContext)}, nil
}

// Notify records only a commit hint. No work or network call runs in the writer.
func (worker *ExecutionPublicationWorker) Notify(ctx context.Context, organization string) {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.closed || organization == "" {
		return
	}
	worker.pending[organization] = trace.SpanContextFromContext(ctx)
	select {
	case worker.wake <- struct{}{}:
	default:
	}
}

func (worker *ExecutionPublicationWorker) Run(ctx context.Context) {
	defer worker.close()
	nextFull := time.Now()
	retryDelay := worker.schedule.RetryInterval
	for ctx.Err() == nil {
		pending := worker.takePending()
		full := !time.Now().Before(nextFull)
		if full {
			nextFull = time.Now().Add(worker.schedule.ResyncInterval)
		}
		if err := worker.publishBatch(ctx, pending, full); err != nil {
			worker.restorePending(pending)
			if ctx.Err() == nil {
				worker.logger.WarnContext(ctx, "Execution configuration synchronization failed",
					"component", "execution_publication", "error_class", "execution_publication_failed")
			}
			if !waitPublication(ctx, retryDelay, nil) {
				return
			}
			retryDelay += min(retryDelay, worker.schedule.MaxRetryInterval-retryDelay)
			nextFull = time.Now()
			continue
		}
		worker.logger.DebugContext(ctx, "Execution configuration synchronization completed",
			"component", "execution_publication", "full_scan", full)
		retryDelay = worker.schedule.RetryInterval
		if !waitPublication(ctx, time.Until(nextFull), worker.wake) {
			return
		}
	}
}

func waitPublication(ctx context.Context, delay time.Duration, wake <-chan struct{}) bool {
	timer := time.NewTimer(max(delay, 0))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-timer.C:
		return true
	}
}

func (worker *ExecutionPublicationWorker) takePending() map[string]trace.SpanContext {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	pending := worker.pending
	worker.pending = make(map[string]trace.SpanContext)
	select {
	case <-worker.wake:
	default:
	}
	return pending
}

func (worker *ExecutionPublicationWorker) restorePending(pending map[string]trace.SpanContext) {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	for org, parent := range pending {
		if _, newer := worker.pending[org]; !newer {
			worker.pending[org] = parent
		}
	}
}

func (worker *ExecutionPublicationWorker) close() {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	worker.closed = true
	worker.pending = nil
}

func (worker *ExecutionPublicationWorker) publishBatch(ctx context.Context, pending map[string]trace.SpanContext, full bool) error {
	if full {
		return worker.publishAll(ctx, pending)
	}
	var failure error
	for _, org := range slices.Sorted(maps.Keys(pending)) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := worker.publishOrganization(ctx, org, pending[org]); err != nil {
			failure = err
		} else {
			delete(pending, org)
		}
	}
	return failure
}

func (worker *ExecutionPublicationWorker) publishAll(ctx context.Context, pending map[string]trace.SpanContext) error {
	const pageSize = 200
	after := ""
	var failure error
	for ctx.Err() == nil {
		page, err := worker.listOrganizations(ctx, after, pageSize)
		if err != nil {
			return err
		}
		for _, org := range page {
			if org <= after {
				return ports.ErrInvalidExecutionConfiguration
			}
			after = org
			parent := pending[org]
			if err := worker.publishOrganization(ctx, org, parent); err != nil {
				failure = err
				pending[org] = parent
			} else {
				delete(pending, org)
			}
		}
		if len(page) < pageSize {
			return failure
		}
	}
	return ctx.Err()
}

func (worker *ExecutionPublicationWorker) listOrganizations(ctx context.Context, after string, limit int) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, worker.schedule.RequestTimeout)
	defer cancel()
	return worker.source.ListExecutionOrganizations(ctx, after, limit)
}

func (worker *ExecutionPublicationWorker) publishOrganization(ctx context.Context, organization string, parent trace.SpanContext) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, worker.schedule.RequestTimeout)
	defer cancel()
	// A retained SpanContext alone is nonrecording, so driver SQL would be
	// suppressed. Each bounded attempt owns the source/HTTP/acknowledgement work.
	ctx, span := worker.tracer.Start(trace.ContextWithSpanContext(ctx, parent), "agent_controller.execution_publication",
		trace.WithAttributes(attribute.String("antnest.organization.id", organization)))
	defer span.End()
	acknowledgement, err := worker.publisher.Publish(ctx, organization)
	if err != nil {
		span.SetStatus(codes.Error, "execution_publication_failed")
		span.SetAttributes(attribute.String("error.type", "execution_publication_failed"), attribute.String("antnest.outcome", "error"))
		return err
	}
	span.SetAttributes(attribute.Int64("antnest.configuration.applied_revision", acknowledgement.AppliedRevision))
	return nil
}
