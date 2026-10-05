package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type observationKey struct{}

// SuppressRPCContent is mandatory for private credential handoffs, regardless
// of the debug capture setting. It disables both request and response capture.
func SuppressRPCContent(ctx context.Context) {
	if state, ok := ctx.Value(observationKey{}).(*httpObservation); ok {
		state.captureRPC = false
	}
}

type httpObservation struct {
	span         trace.Span
	captureRPC   bool
	rpc          bool
	requestBytes int64
	failed       bool
	outcome      string
}

func RPCHandler(method string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if state, ok := r.Context().Value(observationKey{}).(*httpObservation); ok {
			state.rpc = true
			state.span.SetAttributes(attribute.String("rpc.system.name", "antnest.http-json"),
				attribute.String("rpc.service", "runtime-controller"), attribute.String("rpc.method", method))
			if r.Body == nil || r.Body == http.NoBody {
				ObserveRequest(r.Context(), map[string]any{"path": r.URL.Path, "query": r.URL.Query()})
			}
		}
		next.ServeHTTP(w, r)
	})
}

func ObserveRequest(ctx context.Context, value any) {
	if state, ok := ctx.Value(observationKey{}).(*httpObservation); ok {
		state.capture("request", value)
	}
}

func ObserveResponse(w http.ResponseWriter, value any) {
	if writer, ok := w.(*statusWriter); ok {
		writer.observation.capture("response", value)
	}
}

func ObserveOutcome(w http.ResponseWriter, outcome, code string) {
	if writer, ok := w.(*statusWriter); ok {
		writer.observation.outcome = outcome
		writer.observation.span.SetAttributes(attribute.String("antnest.outcome", outcome))
		if outcome == "failed" || outcome == "unknown" {
			ObserveError(w, nil, "rpc_result", code, "Runtime operation did not complete successfully")
		}
	}
}

func ObserveError(w http.ResponseWriter, err error, phase, code, message string) {
	if writer, ok := w.(*statusWriter); ok && !writer.observation.failed {
		writer.observation.failed = true
		RecordFailure(writer.ctx, writer.observation.span, err, phase, code, message)
	}
}

func (s *httpObservation) capture(direction string, value any) {
	if !s.rpc || !s.captureRPC || !s.span.IsRecording() {
		return
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		s.span.AddEvent("antnest.capture.error", trace.WithAttributes(attribute.String("error.type", "json_encoding")))
		return
	}
	s.span.AddEvent("antnest."+direction, trace.WithAttributes(attribute.String("antnest.payload.json", string(encoded))))
}

func SafeValue(value string) string {
	if len(value) > 512 || !utf8.ValidString(value) {
		return ""
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("._:-/", char) {
			continue
		}
		return ""
	}
	return value
}
