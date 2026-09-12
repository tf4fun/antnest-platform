package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/runtime-controller/internal/diagnostics"
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
		attribute.String("error.type", errorType), attribute.String("antnest.error.code", SafeValue(code)),
		attribute.String("antnest.error.type", errorType), attribute.String("antnest.error.stage", SafeValue(phase)),
		attribute.String("antnest.operation.phase", SafeValue(phase)), attribute.String("antnest.outcome", outcome),
	}
	span.SetAttributes(attrs...)
	if outcome != "canceled" {
		span.SetStatus(codes.Error, SafeValue(code))
	}
	causes, marshalErr := json.Marshal(diagnostics.Causes(err))
	attrs = append(attrs, attribute.String("antnest.error.message", message), attribute.StringSlice("antnest.error.cause_types", diagnostics.CauseTypes(err)))
	if marshalErr == nil {
		attrs = append(attrs, attribute.String("antnest.error.causes", string(causes)))
	}
	span.AddEvent("antnest.error", trace.WithAttributes(attrs...))
	if outcome != "canceled" {
		slog.ErrorContext(ctx, "Runtime Controller boundary failed", "phase", phase, "error_code", SafeValue(code), "error_type", errorType, "message", message, "causes", diagnostics.Causes(err))
	}
}

func setDeadline(span trace.Span, ctx context.Context) {
	if deadline, ok := ctx.Deadline(); ok {
		span.SetAttributes(attribute.String("antnest.deadline", deadline.UTC().Format(time.RFC3339Nano)), attribute.Int64("antnest.timeout_ms", max(0, time.Until(deadline).Milliseconds())))
	}
}
