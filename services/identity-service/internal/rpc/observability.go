package rpc

import (
	"net/http"
	"strings"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
)

func (h *Handler) registerObservation(response http.ResponseWriter, request *http.Request) {
	_, pattern := h.mux.Handler(request)
	_, route, _ := strings.Cut(pattern, " ")
	for method, path := range ContractRoutes {
		if path == route {
			telemetry.RegisterRPC(response, method)
			return
		}
	}
	if route == "/protocol/oidc/callback" {
		telemetry.ProtocolFacts(response, attribute.String(semconv.AntnestProtocolName, "oidc"),
			attribute.String(semconv.AntnestOperationPhase, "oidc_callback"))
	}
}
