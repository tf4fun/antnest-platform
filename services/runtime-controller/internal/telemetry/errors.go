package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/diagnostics"
)

// RecordFailure accepts a registered safe message, never an exception string.
// The original error is retained by callers and is only inspected here.
func RecordFailure(ctx context.Context, span trace.Span, err error, phase, code, message string) {
	outcome := "failed"
	if errors.Is(err, context.Canceled) {
		outcome = "canceled"
	}
	errorType := fmt.Sprintf("%T", err)
	if err == nil {
		errorType = "protocol_error"
	}
	if code == "" {
		code = "operation_failed"
	}
	attrs := []attribute.KeyValue{
		attribute.String("error.type", errorType), attribute.String(semconv.AntnestErrorCode, SafeValue(code)),
		attribute.String(semconv.AntnestErrorType, errorType), attribute.String(semconv.AntnestErrorStage, SafeValue(phase)),
		attribute.String(semconv.AntnestOperationPhase, SafeValue(phase)), attribute.String(semconv.AntnestOutcome, outcome),
	}
	span.SetAttributes(semconv.AliasAttributes(attrs...)...)
	if outcome != "canceled" {
		span.SetStatus(codes.Error, SafeValue(code))
	}
	causes, marshalErr := json.Marshal(diagnostics.Causes(err))
	attrs = append(attrs, attribute.String(semconv.AntnestErrorMessage, message), attribute.StringSlice(semconv.AntnestErrorCauseTypes, diagnostics.CauseTypes(err)))
	if marshalErr == nil {
		attrs = append(attrs, attribute.String(semconv.AntnestErrorCauses, string(causes)))
	}
	span.AddEvent(semconv.AntnestError, trace.WithAttributes(semconv.AliasAttributes(attrs...)...))
	if outcome != "canceled" {
		slog.ErrorContext(ctx, "Runtime Controller boundary failed", "phase", phase, "error_code", SafeValue(code), "error_type", errorType, "message", message, "causes", diagnostics.Causes(err))
	}
}

func setDeadline(span trace.Span, ctx context.Context) {
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(semconv.AliasAttributes(attribute.String(semconv.AntnestDeadline, deadline.UTC().Format(time.RFC3339Nano)), attribute.Int64(semconv.AntnestRequestTimeoutMs, max(0, time.Until(deadline).Milliseconds())))...)
	}
}
