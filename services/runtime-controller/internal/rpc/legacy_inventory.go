package rpc

import (
	"net/http"

	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
)

func (h *Handler) legacySystemSkillsInventory(response http.ResponseWriter, request *http.Request) {
	if h.legacyInventory == nil {
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{
			Code: "legacy_inventory_unavailable", Message: "Legacy system Skill inventory is unavailable", Retryable: true,
		})
		return
	}
	inventory, err := h.legacyInventory.Inventory(request.Context())
	if err != nil {
		telemetry.ObserveError(response, err, "legacy_inventory", "legacy_inventory_unavailable", "Legacy system Skill inventory is unavailable")
		writeJSON(response, http.StatusServiceUnavailable, errorResponse{
			Code: "legacy_inventory_unavailable", Message: "Legacy system Skill inventory is unavailable", Retryable: true,
		})
		return
	}
	writeJSON(response, http.StatusOK, inventory)
}
