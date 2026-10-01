package scim

import (
	"net/http"
	"strings"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
)

func (h *HTTPHandler) registerObservation(w http.ResponseWriter, r *http.Request) {
	_, pattern := h.mux.Handler(r)
	if pattern == "" {
		return
	}
	if _, route, ok := strings.Cut(pattern, " "); ok {
		pattern = route
	}
	telemetry.ProtocolFacts(w, attribute.String("antnest.protocol.name", "scim"),
		attribute.String("antnest.protocol.version", "2.0"), attribute.String("antnest.operation.phase", r.Method+" "+pattern))
}
