package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func (h *handler) registerCatalogAvailabilityRoutes() {
	for _, route := range []struct{ browser, owner, parameter string }{
		{"provider-connections", "provider-connections", "connection_id"},
		{"model-profiles", "model-profiles", "model_profile_id"},
		{"templates", "agent-templates", "template_id"},
	} {
		h.mux.HandleFunc("PUT /api/admin/"+route.browser+"/{"+route.parameter+"}/availability",
			h.withPrincipal(h.catalogAvailability(route.owner, route.parameter)))
	}
}

func (h *handler) catalogAvailability(owner, parameter string) adminHandler {
	return func(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
		if _, ok := parseListQuery(w, r); !ok {
			return
		}
		var input struct {
			ExpectedEnabled *bool `json:"expected_enabled"`
			Enabled         *bool `json:"enabled"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if input.ExpectedEnabled == nil || input.Enabled == nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "expected_enabled and enabled must be explicit booleans")
			return
		}
		requestID, ok := commandRequestID(w, r, actor.OrganizationID, "catalog-availability")
		if !ok {
			return
		}
		resourceID := r.PathValue(parameter)
		h.forwardProjectedJSONNoStore(w, r, upstream.AgentController, http.MethodPut,
			"/internal/"+owner+"/"+url.PathEscape(resourceID)+"/availability", "", map[string]any{
				"request_id": requestID, "organization_id": actor.OrganizationID,
				"expected_enabled": *input.ExpectedEnabled, "enabled": *input.Enabled,
			}, projectCatalogAvailability(resourceID, *input.Enabled))
	}
}

func projectCatalogAvailability(resourceID string, enabled bool) payloadProjector {
	return func(payload []byte) ([]byte, error) {
		var receipt struct {
			ResourceID string    `json:"resource_id"`
			Enabled    *bool     `json:"enabled"`
			UpdatedAt  time.Time `json:"updated_at"`
		}
		if err := json.Unmarshal(payload, &receipt); err != nil {
			return nil, err
		}
		if receipt.ResourceID != resourceID || receipt.Enabled == nil || *receipt.Enabled != enabled || receipt.UpdatedAt.IsZero() {
			return nil, fmt.Errorf("invalid catalog availability receipt")
		}
		return json.Marshal(receipt)
	}
}
