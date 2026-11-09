package scim

import (
	"net/http"
	"strings"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
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
	telemetry.ProtocolFacts(w, attribute.String(semconv.AntnestProtocolName, "scim"),
		attribute.String(semconv.AntnestProtocolVersion, "2.0"), attribute.String(semconv.AntnestOperationPhase, r.Method+" "+pattern))
}
