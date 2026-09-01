package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ObservedRunStore struct {
	next   ports.RunStore
	logger *slog.Logger
}

func ObserveRunStore(next ports.RunStore, logger *slog.Logger) (*ObservedRunStore, error) {
	if next == nil || logger == nil {
		return nil, fmt.Errorf("run store and logger are required")
	}
	return &ObservedRunStore{next: next, logger: logger}, nil
}

func (store *ObservedRunStore) ResolveAgentAccess(
	ctx context.Context, subject string,
) (result ports.AgentAccessResolution, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "resolve_agent_access")
	defer func() { store.finish(ctx, span, started, "resolve_agent_access", resultErr) }()
	return store.next.ResolveAgentAccess(ctx, subject)
}

func (store *ObservedRunStore) AcquireRun(
	ctx context.Context, input ports.AcquireRunRecord,
) (result ports.RunAdmissionRecord, replayed bool, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "acquire_run")
	defer func() {
		span.SetAttributes(
			attribute.Bool("antnest.run_admission.replayed", replayed),
			attribute.String("antnest.run_admission.state", string(result.State)),
		)
		store.finish(ctx, span, started, "acquire_run", resultErr)
	}()
	return store.next.AcquireRun(ctx, input)
}

func (store *ObservedRunStore) FinishRun(
	ctx context.Context, input ports.FinishRunCommand,
) (result ports.FinishRunRecord, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "finish_run")
	span.SetAttributes(
		attribute.String("antnest.run.terminal_class", string(input.Report.Class)),
		attribute.String("antnest.run.tool_effect_state", string(input.Report.ToolEffectState)),
		attribute.String("antnest.run.unknown_effect_source", string(input.Report.UnknownEffectSource)),
	)
	defer func() {
		span.SetAttributes(
			attribute.String("antnest.run_admission.state", string(result.AdmissionState)),
			attribute.String("antnest.run_admission.finish_status", result.Status),
		)
		store.finish(ctx, span, started, "finish_run", resultErr)
	}()
	return store.next.FinishRun(ctx, input)
}

func (store *ObservedRunStore) GetAdmissionCredential(
	ctx context.Context, admissionID string, credentialRef string, now time.Time,
) (result ports.AdmissionCredential, resultErr error) {
	ctx, span, started := startRepositorySpan(ctx, "get_admission_credential")
	defer func() { store.finish(ctx, span, started, "get_admission_credential", resultErr) }()
	return store.next.GetAdmissionCredential(ctx, admissionID, credentialRef, now)
}

func (store *ObservedRunStore) finish(
	ctx context.Context,
	span trace.Span,
	started time.Time,
	operation string,
	err error,
) {
	finishRepositorySpan(ctx, store.logger, span, started, operation, err)
}

var _ ports.RunStore = (*ObservedRunStore)(nil)
