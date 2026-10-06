package server

import (
	"context"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type mcpSecretResolver interface {
	ResolveMCPSecrets(context.Context, ports.MCPTemplateSource) (map[string]map[string]string, error)
}

func (h *handler) resolveMCPSecrets(w http.ResponseWriter, r *http.Request) {
	var input ports.MCPTemplateSource
	if !decodeJSON(w, r, &input) {
		return
	}
	resolver, ok := h.catalog.(mcpSecretResolver)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "dependency_unavailable", "Managed MCP bootstrap unavailable", true)
		return
	}
	values, err := resolver.ResolveMCPSecrets(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "dependency_unavailable", "Managed MCP bootstrap unavailable", true)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, values)
}
