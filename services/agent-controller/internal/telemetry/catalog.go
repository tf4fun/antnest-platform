package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var (
	repositoryMeter = otel.Meter(instrumentationName + "/repository")
	repositoryCalls = mustCounter(repositoryMeter.Int64Counter(
		"antnest.agent_controller.repository.operations",
	))
	repositoryDuration = mustHistogram(repositoryMeter.Float64Histogram(
		"antnest.agent_controller.repository.operation.duration", metric.WithUnit("s"),
	))
)

type ObservedCatalogStore struct {
	next   ports.CatalogStore
	logger *slog.Logger
}

func ObserveCatalogStore(next ports.CatalogStore, logger *slog.Logger) (*ObservedCatalogStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("catalog store and logger are required")
	}
	return &ObservedCatalogStore{next: next, logger: logger}, nil
}

func (store *ObservedCatalogStore) ReplayModelProfileRequest(
	ctx context.Context, kind ports.CatalogRequestKind, requestID string, fingerprint string,
) (ports.ModelProfileRecord, bool, error) {
	return observeReplay(ctx, store, "replay_model_profile_request", func(callCtx context.Context) (ports.ModelProfileRecord, bool, error) {
		return store.next.ReplayModelProfileRequest(callCtx, kind, requestID, fingerprint)
	})
}

func (store *ObservedCatalogStore) PutModelProfile(
	ctx context.Context, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return observeValue(ctx, store, "create_model_profile", func(callCtx context.Context) (ports.ModelProfileRecord, error) {
		return store.next.PutModelProfile(callCtx, record)
	})
}

func (store *ObservedCatalogStore) ReviseModelProfile(
	ctx context.Context, expectedRevision int64, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return observeValue(ctx, store, "revise_model_profile", func(callCtx context.Context) (ports.ModelProfileRecord, error) {
		return store.next.ReviseModelProfile(callCtx, expectedRevision, record)
	})
}

func (store *ObservedCatalogStore) GetModelProfile(
	ctx context.Context, id string,
) (ports.ModelProfileRecord, error) {
	return observeValue(ctx, store, "get_model_profile", func(callCtx context.Context) (ports.ModelProfileRecord, error) {
		return store.next.GetModelProfile(callCtx, id)
	})
}

func (store *ObservedCatalogStore) GetModelProfileRevision(
	ctx context.Context, id string,
) (domain.ModelProfileRevision, error) {
	return observeValue(ctx, store, "get_model_profile_revision", func(callCtx context.Context) (domain.ModelProfileRevision, error) {
		return store.next.GetModelProfileRevision(callCtx, id)
	})
}

func (store *ObservedCatalogStore) ListModelProfiles(
	ctx context.Context, organizationID string, afterID string, limit int,
) ([]ports.ModelProfileRecord, string, error) {
	return observeList(ctx, store, "list_model_profiles", func(callCtx context.Context) ([]ports.ModelProfileRecord, string, error) {
		return store.next.ListModelProfiles(callCtx, organizationID, afterID, limit)
	})
}

func (store *ObservedCatalogStore) ReplayTemplateRequest(
	ctx context.Context, kind ports.CatalogRequestKind, requestID string, fingerprint string,
) (ports.TemplateRecord, bool, error) {
	return observeReplay(ctx, store, "replay_template_request", func(callCtx context.Context) (ports.TemplateRecord, bool, error) {
		return store.next.ReplayTemplateRequest(callCtx, kind, requestID, fingerprint)
	})
}

func (store *ObservedCatalogStore) PutTemplate(
	ctx context.Context, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return observeValue(ctx, store, "create_template", func(callCtx context.Context) (ports.TemplateRecord, error) {
		return store.next.PutTemplate(callCtx, record)
	})
}

func (store *ObservedCatalogStore) ReviseTemplate(
	ctx context.Context, expectedRevision int64, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return observeValue(ctx, store, "revise_template", func(callCtx context.Context) (ports.TemplateRecord, error) {
		return store.next.ReviseTemplate(callCtx, expectedRevision, record)
	})
}

func (store *ObservedCatalogStore) GetTemplate(
	ctx context.Context, id string,
) (ports.TemplateRecord, error) {
	return observeValue(ctx, store, "get_template", func(callCtx context.Context) (ports.TemplateRecord, error) {
		return store.next.GetTemplate(callCtx, id)
	})
}

func (store *ObservedCatalogStore) GetTemplateRevision(
	ctx context.Context, id string, revision int64,
) (domain.TemplateRevision, error) {
	return observeValue(ctx, store, "get_template_revision", func(callCtx context.Context) (domain.TemplateRevision, error) {
		return store.next.GetTemplateRevision(callCtx, id, revision)
	})
}

func (store *ObservedCatalogStore) ListTemplates(
	ctx context.Context, organizationID string, afterID string, limit int,
) ([]ports.TemplateRecord, string, error) {
	return observeList(ctx, store, "list_templates", func(callCtx context.Context) ([]ports.TemplateRecord, string, error) {
		return store.next.ListTemplates(callCtx, organizationID, afterID, limit)
	})
}

func observeValue[T any](
	ctx context.Context,
	store *ObservedCatalogStore,
	operation string,
	call func(context.Context) (T, error),
) (value T, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func observeReplay[T any](
	ctx context.Context,
	store *ObservedCatalogStore,
	operation string,
	call func(context.Context) (T, bool, error),
) (value T, replayed bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func observeList[T any](
	ctx context.Context,
	store *ObservedCatalogStore,
	operation string,
	call func(context.Context) ([]T, string, error),
) (items []T, cursor string, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, operation)
	defer func() { store.finish(ctx, span, started, operation, resultErr) }()
	return call(ctx)
}

func startRepositorySpan(ctx context.Context, operation string) (context.Context, trace.Span, time.Time) {
	ctx, span := otel.Tracer(instrumentationName+"/repository").Start(
		ctx, "agent_controller.repository."+operation, trace.WithSpanKind(trace.SpanKindClient),
	)
	return ctx, span, time.Now()
}

func (store *ObservedCatalogStore) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	finishRepositorySpan(ctx, store.logger, span, started, operation, err)
}

func finishRepositorySpan(
	ctx context.Context,
	logger *slog.Logger,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	result := "success"
	if err != nil {
		result = "error"
		errorClass := catalogStoreErrorClass(err)
		span.SetStatus(codes.Error, errorClass)
		logger.ErrorContext(ctx, "Agent Controller repository operation failed",
			"operation", operation, "error_class", errorClass,
		)
	}
	attributes := []attribute.KeyValue{
		attribute.String("db.system.name", "postgresql"),
		attribute.String("antnest.repository.operation", operation),
		attribute.String("antnest.result", result),
	}
	span.SetAttributes(attributes...)
	span.End()
	repositoryCalls.Add(ctx, 1, metric.WithAttributes(attributes...))
	repositoryDuration.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(attributes...))
}

func catalogStoreErrorClass(err error) string {
	switch {
	case errors.Is(err, ports.ErrNotFound):
		return "not_found"
	case errors.Is(err, ports.ErrDisabledReference):
		return "disabled_reference"
	case errors.Is(err, ports.ErrRequestConflict):
		return "request_conflict"
	case errors.Is(err, ports.ErrConcurrentChange):
		return "concurrent_change"
	case errors.Is(err, ports.ErrLifecycleRecoveryClaimLost):
		return "recovery_claim_lost"
	case errors.Is(err, ports.ErrRunAccessDenied):
		return "access_denied"
	case errors.Is(err, ports.ErrAgentBusy):
		return "agent_busy"
	case errors.Is(err, ports.ErrAgentRebuilding):
		return "agent_rebuilding"
	case errors.Is(err, ports.ErrAgentBuildFailed):
		return "agent_build_failed"
	case errors.Is(err, ports.ErrAgentNotReady):
		return "agent_not_ready"
	case errors.Is(err, ports.ErrAdmissionNotFound):
		return "admission_not_found"
	case errors.Is(err, ports.ErrCredentialNotAllowed):
		return "credential_not_allowed"
	default:
		return "persistence_error"
	}
}

var _ ports.CatalogStore = (*ObservedCatalogStore)(nil)
