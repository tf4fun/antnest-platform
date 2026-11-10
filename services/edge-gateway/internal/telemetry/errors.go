package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

func recordFailure(span trace.Span, stage string, err error) {
	if err == nil {
		return
	}
	kind, message := classifyError(err)
	span.SetAttributes(attribute.String("error.type", kind))
	span.SetStatus(codes.Error, message)
	span.AddEvent(semconv.AntnestError, trace.WithAttributes(semconv.AliasAttributes(
		attribute.String("error.type", kind), attribute.String(semconv.AntnestErrorStage, stage),
		attribute.String(semconv.AntnestErrorMessage, message),
		attribute.StringSlice(semconv.AntnestErrorCauseTypes, causeTypes(err)),
	)...))
}

func classifyError(err error) (string, string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded), os.IsTimeout(err):
		return "deadline_exceeded", "Request deadline exceeded"
	case errors.Is(err, context.Canceled):
		return "cancelled", "Request was cancelled"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof", "Response ended before completion"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied", "Operation was denied by the operating system"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns_error", "Could not resolve the remote service"
	}
	var network *net.OpError
	if errors.As(err, &network) {
		return "network_error", "Network operation failed"
	}
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return "invalid_json", fmt.Sprintf("Invalid JSON at byte %d", syntax.Offset)
	}
	var mismatch *json.UnmarshalTypeError
	if errors.As(err, &mismatch) {
		return "invalid_json_type", fmt.Sprintf("Unexpected JSON value type at byte %d", mismatch.Offset)
	}
	return "operation_failed", "Operation failed; unclassified error text was not exported"
}

func causeTypes(err error) []string {
	return semconv.CauseTypes(err, 4)
}

// Handler binds error-returning HTTP adapters without adding another span.
// The outer HTTP boundary observes the error before finishing its response.
func Handler(next func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := next(w, r); err != nil {
			if outcome, ok := r.Context().Value(requestOutcomeKey{}).(*requestOutcome); ok {
				outcome.err = err
			}
		}
	}
}

type requestOutcomeKey struct{}
type requestOutcome struct{ err error }
