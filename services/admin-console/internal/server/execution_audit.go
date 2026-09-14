package server

import (
	"net/http"
	"strconv"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

func (h *handler) listExecutionAudits(w http.ResponseWriter, r *http.Request, _ principal.Principal) {
	payload, ok := executionAuditQuery(w, r, "agent_id", "session_id", "created_from", "created_until", "limit", "cursor")
	if !ok {
		return
	}
	h.forwardProjectedJSONNoStore(w, r, upstream.AgentACP, http.MethodPost,
		"/rpc/agent-acp/list-execution-audits", "", payload, projectExecutionAuditList)
}

func (h *handler) getExecutionAudit(w http.ResponseWriter, r *http.Request, _ principal.Principal) {
	if _, ok := parseListQuery(w, r); !ok {
		return
	}
	h.forwardProjectedJSONNoStore(w, r, upstream.AgentACP, http.MethodPost,
		"/rpc/agent-acp/get-execution-audit", "", map[string]string{"run_id": r.PathValue("run_id")}, projectExecutionAuditDetail)
}

func (h *handler) listExecutionAuditEvents(w http.ResponseWriter, r *http.Request, _ principal.Principal) {
	payload, ok := executionAuditQuery(w, r, "stream", "limit", "cursor")
	if !ok {
		return
	}
	payload["run_id"] = r.PathValue("run_id")
	h.forwardProjectedJSONNoStore(w, r, upstream.AgentACP, http.MethodPost,
		"/rpc/agent-acp/list-execution-events", "", payload, projectExecutionAuditEvents)
}

func executionAuditQuery(w http.ResponseWriter, r *http.Request, allowed ...string) (map[string]any, bool) {
	query, ok := parseListQuery(w, r, allowed...)
	if !ok {
		return nil, false
	}
	payload := make(map[string]any, len(query))
	for name, values := range query {
		if values[0] == "" {
			writeInvalidListQuery(w)
			return nil, false
		}
		payload[name] = values[0]
	}
	if values, exists := query["limit"]; exists {
		limit, err := strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > maximumBrowserPageSize {
			writeInvalidListQuery(w)
			return nil, false
		}
		payload["limit"] = limit
	}
	return payload, true
}

func (h *handler) getExecutionSynchronization(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	if _, ok := parseListQuery(w, r); !ok {
		return
	}
	h.forwardProjected(w, r, upstream.AgentController, http.MethodGet,
		"/internal/execution-synchronization", organizationScopeQuery(actor.OrganizationID), nil,
		projectExecutionSynchronization(actor.OrganizationID))
}
