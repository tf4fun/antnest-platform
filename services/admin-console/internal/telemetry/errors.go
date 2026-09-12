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
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// SafeFailure is implemented only by protocol adapters with fixed, reviewed
// messages. Error() text from arbitrary dependencies is never exported.
type SafeFailure interface {
	error
	SafeCode() string
	SafeMessage() string
	HTTPStatus() int
}

type requestOutcomeKey struct{}
type requestOutcome struct {
	mu  sync.Mutex
	err error
}

func (o *requestOutcome) set(err error) {
	if err == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err == nil {
		o.err = err
	}
}

func (o *requestOutcome) get() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.err
}

// Handler binds the existing error-returning adapter to the HTTP SERVER span.
func Handler(next func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := next(w, r); err != nil {
			if outcome, ok := r.Context().Value(requestOutcomeKey{}).(*requestOutcome); ok {
				outcome.set(err)
			}
		}
	}
}

func errorSummary(err error) (string, string) {
	var safe SafeFailure
	if errors.As(err, &safe) {
		return safe.SafeCode(), safe.SafeMessage()
	}
	switch {
	case errors.Is(err, context.Canceled):
		return "cancelled", "Request was cancelled"
	case errors.Is(err, context.DeadlineExceeded), os.IsTimeout(err):
		return "deadline_exceeded", "Request deadline exceeded"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "unexpected_eof", "Response ended before completion"
	case errors.Is(err, io.ErrClosedPipe):
		return "closed_pipe", "Response connection was closed"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied", "Operation was denied by the operating system"
	}
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return "invalid_json", fmt.Sprintf("Invalid JSON at byte %d", syntax.Offset)
	}
	var mismatch *json.UnmarshalTypeError
	if errors.As(err, &mismatch) {
		return "invalid_json_type", fmt.Sprintf("Unexpected JSON value type at byte %d", mismatch.Offset)
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns_error", "Could not resolve the remote service"
	}
	var network *net.OpError
	if errors.As(err, &network) {
		return "network_error", "Network operation failed"
	}
	return "operation_failed", "Operation failed; unclassified error text was omitted"
}

func recordFailure(span trace.Span, stage string, err error, observedStatus ...int) {
	if err == nil {
		return
	}
	kind, message := errorSummary(err)
	outcome := "failure"
	var safe SafeFailure
	rejected := errors.As(err, &safe) && safe.HTTPStatus() >= 400 && safe.HTTPStatus() < 500
	if len(observedStatus) > 0 && observedStatus[0] >= 400 && observedStatus[0] < 500 {
		rejected = true
	}
	if errors.Is(err, context.Canceled) {
		outcome = "cancelled"
	} else if rejected {
		outcome = "rejected"
	}
	span.SetAttributes(attribute.String("error.type", kind), attribute.String("antnest.outcome", outcome))
	if !rejected && outcome != "cancelled" {
		span.SetStatus(codes.Error, message)
	}
	types, causes := safeCauses(err)
	encodedCauses, marshalErr := json.Marshal(causes)
	if marshalErr != nil {
		encodedCauses = []byte("[]")
	}
	span.AddEvent("antnest.error", trace.WithAttributes(
		attribute.String("error.type", kind), attribute.String("antnest.error.type", kind), attribute.String("antnest.error.code", kind),
		attribute.String("antnest.error.stage", stage), attribute.String("antnest.error.message", message),
		attribute.StringSlice("antnest.error.cause_types", types), attribute.String("antnest.error.causes", string(encodedCauses)),
	))
}

func safeCauses(err error) ([]string, []string) {
	var types, causes []string
	var visit func(error)
	visit = func(current error) {
		if current == nil || len(types) == 4 {
			return
		}
		types = append(types, fmt.Sprintf("%T", current))
		_, message := errorSummary(current)
		if len(message) > 2048 {
			message = "Safe message exceeded budget"
		}
		causes = append(causes, message)
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, child := range joined.Unwrap() {
				visit(child)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	return types, causes
}
