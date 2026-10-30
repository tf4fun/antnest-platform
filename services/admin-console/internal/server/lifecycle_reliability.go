package server

import (
	"net/http"
	"net/url"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

// cancelLifecycleOperation forwards a cancellation request for the scoped
// Agent's running lifecycle operation. The upstream 202 means the request was
// acknowledged, not that resources are cleaned.
func (h *handler) cancelLifecycleOperation(
	response http.ResponseWriter, request *http.Request, actor principal.Principal,
) {
	agentID := request.PathValue("agent_id")
	if !runtimeRecoveryIdentifier.MatchString(agentID) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Agent identifier is invalid")
		return
	}
	if len(request.URL.RawQuery) != 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Query parameters are not accepted")
		return
	}
	var input struct {
		OperationRequestID string `json:"operation_request_id"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.OperationRequestID) || !runtimeRecoveryIdentifier.MatchString(input.OperationRequestID) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Operation request identifier is invalid")
		return
	}
	payload := map[string]any{
		"organization_id":      actor.OrganizationID,
		"actor_principal_id":   actor.UserID,
		"operation_request_id": input.OperationRequestID,
	}
	h.forwardProjectedJSON(
		response, request, upstream.AgentController, http.MethodPost,
		"/internal/agents/"+url.PathEscape(agentID)+"/lifecycle-operation/cancel", "",
		payload, projectOperation,
	)
}

// clearLifecycleQuarantine forwards a quarantine-clear request carrying the
// caller's captured aggregate sequence. The upstream 200 returns the cleared
// Agent; a 409 means the sequence was stale and must be reread, never retried.
func (h *handler) clearLifecycleQuarantine(
	response http.ResponseWriter, request *http.Request, actor principal.Principal,
) {
	agentID := request.PathValue("agent_id")
	if !runtimeRecoveryIdentifier.MatchString(agentID) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Agent identifier is invalid")
		return
	}
	if len(request.URL.RawQuery) != 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Query parameters are not accepted")
		return
	}
	var input struct {
		ExpectedAggregateSequence int64 `json:"expected_aggregate_sequence"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.ExpectedAggregateSequence < 1 ||
		input.ExpectedAggregateSequence > int64(maximumBrowserVersion) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Expected aggregate sequence is invalid")
		return
	}
	payload := map[string]any{
		"organization_id":             actor.OrganizationID,
		"actor_principal_id":          actor.UserID,
		"expected_aggregate_sequence": input.ExpectedAggregateSequence,
	}
	h.forwardProjectedJSON(
		response, request, upstream.AgentController, http.MethodPost,
		"/internal/agents/"+url.PathEscape(agentID)+"/lifecycle-quarantine/clear", "",
		payload, projectAgent,
	)
}
