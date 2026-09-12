package telemetry

import (
	"encoding/json"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// RPCHandler binds protocol metadata at registration, never by inspecting URLs.
func RPCHandler(method string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if observed, ok := w.(*statusWriter); ok {
			observed.rpc = true
			trace.SpanFromContext(r.Context()).SetAttributes(
				attribute.String("rpc.system.name", "antnest.http-json"),
				attribute.String("rpc.service", "agent-controller"), attribute.String("rpc.method", method))
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
	encoded, err := json.Marshal(value)
	if err != nil {
		span.AddEvent("antnest.capture.error", trace.WithAttributes(attribute.String("error.type", "json_encoding")))
		return
	}
	span.AddEvent("antnest."+direction, trace.WithAttributes(attribute.String("antnest.payload.json", string(encoded))))
}
