package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// Error strings can contain URLs, SQL values or provider credentials. Only
// registered classifications and type names cross the diagnostic boundary.
func safeError(err error) (string, string) {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled", "operation canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout", "operation deadline exceeded"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof", "response ended before completion"
	case errors.Is(err, io.ErrClosedPipe):
		return "closed_pipe", "connection closed during transfer"
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return "timeout", "network deadline exceeded"
	}
	var dependency *ports.DependencyError
	if errors.As(err, &dependency) {
		code := SafeCode(dependency.Code)
		return code, "dependency returned " + code
	}
	return "boundary_error", "boundary failed; unregistered error message omitted"
}

func SafeCode(code string) string {
	switch code {
	case "invalid_request", "invalid_response", "control_plane_unavailable", "identity_unavailable",
		"operation_unverified", "operation_not_found", "runtime_not_ready", "platform_unavailable",
		"operation_failed", "agent_not_found", "agent_busy", "agent_rebuilding", "agent_build_failed",
		"agent_not_ready", "access_denied", "reference_not_found", "reference_disabled", "model_unavailable",
		"configuration_conflict", "lifecycle_conflict", "dependency_invalid_response",
		"request_id_conflict", "lifecycle_timeout", "dependency_unavailable", "internal_error",
		"runtime_image_invalid", "not_found", "bad_request", "invalid_argument", "resource_version_conflict",
		"agent_network_not_found", "policy_revision_not_found", "agent_network_unavailable", "cleanup_failed":
		return code
	case "invalid_execution_configuration", "configuration_too_large", "configuration_unavailable",
		"invalid_agent_settlement", "agent_operation_conflict", "settlement_unavailable":
		return code
	default:
		return "unclassified_error"
	}
}

func RecordBoundaryError(ctx context.Context, err error, phase, code, message string, fault bool) {
	if err == nil {
		return
	}
	span := trace.SpanFromContext(ctx)
	kind, safeMessage := safeError(err)
	if code != "" {
		code = SafeCode(code)
	} else {
		code = kind
	}
	// Caller-supplied messages must be static adapter-owned public mappings.
	if message != "" && len(message) <= 2048 {
		safeMessage = message
	}
	outcome := "rejected"
	if fault {
		outcome = "error"
		span.SetStatus(codes.Error, code)
	}
	if errors.Is(err, context.Canceled) {
		outcome = "canceled"
	}
	attrs := []attribute.KeyValue{
		attribute.String("error.type", kind), attribute.String("antnest.error.code", code),
		attribute.String("antnest.error.stage", phase), attribute.String("antnest.error.type", kind), attribute.String("antnest.outcome", outcome),
	}
	span.SetAttributes(attrs...)
	causes := make([]string, 0, 4)
	causeTypes := make([]string, 0, 4)
	pending := []error{err}
	for len(pending) > 0 && len(causes) < 4 {
		current := pending[0]
		pending = pending[1:]
		if current == nil {
			continue
		}
		typeName := fmt.Sprintf("%T", current)
		causeTypes = append(causeTypes, typeName)
		cause, description := safeError(current)
		causes = append(causes, typeName+": "+cause+": "+description)
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			children := joined.Unwrap()
			pending = append(pending, children[:min(len(children), 4-len(causes))]...)
		} else if child := errors.Unwrap(current); child != nil {
			pending = append(pending, child)
		}
	}
	encodedCauses, encodeErr := json.Marshal(causes)
	if encodeErr != nil {
		encodedCauses = nil
	}
	span.AddEvent("antnest.error", trace.WithAttributes(append(attrs,
		attribute.String("antnest.error.message", safeMessage),
		attribute.StringSlice("antnest.error.cause_types", causeTypes),
		attribute.String("antnest.error.causes", string(encodedCauses)),
	)...))
}
