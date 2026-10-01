package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func observeDTO(response http.ResponseWriter, direction string, value any) {
	telemetry.CaptureDTO(response, direction, value)
	if writer, ok := response.(interface{ TraceContext() context.Context }); ok && direction == "response" {
		observeProtocolResult(response, writer.TraceContext(), value)
	}
}

func observeProtocolResult(response http.ResponseWriter, ctx context.Context, value any) {
	var operation operationResponse
	switch result := value.(type) {
	case errorResponse:
		outcome := "rejected"
		if writer, ok := response.(interface{ HTTPStatus() int }); ok && writer.HTTPStatus() >= 500 {
			outcome = "error"
		}
		telemetry.RecordHTTPOutcome(response, outcome)
		trace.SpanFromContext(ctx).SetAttributes(attribute.String("antnest.error.code", telemetry.SafeCode(result.Code)), attribute.String("antnest.outcome", outcome))
		return
	case operationResponse:
		operation = result
	case createAgentResponse:
		operation = result.Operation
	default:
		return
	}
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attribute.String("antnest.operation.id", operation.RequestID), attribute.String("antnest.operation.phase", string(operation.Phase)), attribute.String("antnest.outcome", string(operation.State)))
	if operation.State == "failed" {
		telemetry.RecordHTTPOutcome(response, "error")
		telemetry.RecordBoundaryError(ctx, errors.New("lifecycle result failed"), string(operation.Phase), operation.ErrorCode, "lifecycle operation failed", true)
	}
}
