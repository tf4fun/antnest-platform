package telemetry

import (
	"encoding/json"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func observation(w http.ResponseWriter) *statusWriter {
	for {
		if observed, ok := w.(*statusWriter); ok {
			return observed
		}
		unwrapper, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return nil
		}
		w = unwrapper.Unwrap()
	}
}

// RegisterRPC is called by the protocol dispatcher, not inferred from a URL.
func RegisterRPC(w http.ResponseWriter, method string) {
	if observed := observation(w); observed != nil {
		observed.rpc = true
		observed.span.SetAttributes(attribute.String("rpc.system.name", "antnest.http-json"),
			attribute.String("rpc.service", "identity"), attribute.String("rpc.method", method))
		if method == "local_login" {
			observed.span.SetAttributes(attribute.String("antnest.identity.authentication_method", "local"))
		}
	}
}

func ProtocolFacts(w http.ResponseWriter, attributes ...attribute.KeyValue) {
	if observed := observation(w); observed != nil {
		observed.span.SetAttributes(attributes...)
	}
}

func RequestValue(w http.ResponseWriter, value any)  { rpcValue(w, "request", value) }
func ResponseValue(w http.ResponseWriter, value any) { rpcValue(w, "response", value) }

func rpcValue(w http.ResponseWriter, direction string, value any) {
	observed := observation(w)
	if observed == nil || !observed.rpc || !observed.captureRPC || !observed.span.IsRecording() {
		return
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		observed.span.AddEvent("antnest.capture.error", trace.WithAttributes(attribute.String("error.type", "json_encoding")))
		return
	}
	observed.span.AddEvent("antnest."+direction, trace.WithAttributes(attribute.String("antnest.payload.json", string(encoded))))
}

func ProtocolError(w http.ResponseWriter, err error) {
	if observed := observation(w); observed != nil && err != nil && observed.err == nil {
		observed.err = err
	}
}
