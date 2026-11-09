package telemetry

import (
	"net/http"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// RPCHandler binds protocol metadata at registration, never by inspecting URLs.
func RPCHandler(method string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if observed, ok := w.(*statusWriter); ok {
			observed.rpc = true
			trace.SpanFromContext(r.Context()).SetAttributes(
				semconv.AliasAttributes(attribute.String("rpc.system.name", "antnest.http-json"),
					attribute.String("rpc.service", "agent-controller"), attribute.String("rpc.method", method))...)
			if r.Body == nil || r.Body == http.NoBody {
				CaptureDTO(w, "request", map[string]any{"path": r.URL.Path, "query": r.URL.Query()})
			}
		}
		next.ServeHTTP(w, r)
	})
}

func CaptureDTO(w http.ResponseWriter, direction string, value any) {
	observed, ok := w.(*statusWriter)
	if !ok || !observed.rpc || !observed.captureRPC {
		return
	}
	span := trace.SpanFromContext(observed.TraceContext())
	if !span.IsRecording() {
		return
	}
	semconv.CaptureRPC(span, true, direction, value)
}
