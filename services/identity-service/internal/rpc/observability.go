package rpc

import (
	"net/http"
	"strings"

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
		telemetry.ProtocolFacts(response, attribute.String("antnest.protocol.name", "oidc"),
			attribute.String("antnest.operation.phase", "oidc_callback"))
	}
}
