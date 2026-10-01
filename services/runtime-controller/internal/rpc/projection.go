package rpc

import (
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
	"net/http"
)

func observeRequest(request *http.Request, value any) {
	telemetry.ObserveRequest(request.Context(), map[string]any{
		"path": request.URL.Path, "query": request.URL.Query(), "params": value,
	})
}

func observeResponse(w http.ResponseWriter, value any) {
	telemetry.ObserveResponse(w, value)
	if output, ok := value.(operationDTO); ok {
		telemetry.ObserveOutcome(w, string(output.State), output.ErrorCode)
	}
}
