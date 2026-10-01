package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

const maximumBrowserVersion uint64 = 1<<53 - 1

var networkPolicyKey = regexp.MustCompile(`^[!-~]{1,255}$`)
var networkPolicyDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

type networkPolicyInput struct {
	Action                  string `json:"action"`
	ExpectedResourceVersion uint64 `json:"expected_resource_version"`
}

type networkPolicyAssignmentSource struct {
	AgentID         string `json:"agent_id"`
	PolicyID        string `json:"policy_id"`
	Revision        uint64 `json:"revision"`
	ResourceVersion uint64 `json:"resource_version"`
}

type networkPolicyAssignmentView struct {
	AgentID         string `json:"agent_id"`
	Action          string `json:"action"`
	ResourceVersion uint64 `json:"resource_version"`
}

type networkAttachmentView struct {
	State           string `json:"state"`
	ResourceVersion uint64 `json:"resource_version"`
}

type networkPolicyView struct {
	networkPolicyAssignmentView
	Attachment networkAttachmentView `json:"attachment"`
}

func networkActionValid(action string) bool   { return action == "allow_all" || action == "deny_all" }
func browserVersionValid(version uint64) bool { return version > 0 && version <= maximumBrowserVersion }

func (h *handler) getNetworkPolicy(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := parseListQuery(w, r); !ok {
		return
	}
	agentID := r.PathValue("agent_id")
	result, ok := h.read(w, r, upstream.AgentController, http.MethodGet, "/internal/agents/"+url.PathEscape(agentID)+"/network-policy", organizationScopeQuery(actor.OrganizationID), nil)
	if !ok {
		return
	}
	h.writeNetworkPolicy(w, r, result, func(body []byte) ([]byte, error) { return projectNetworkPolicy(body, agentID) })
}

func (h *handler) setNetworkPolicy(w http.ResponseWriter, r *http.Request, actor principal.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	if !networkPrincipalMatches(r, actor) {
		writeError(w, http.StatusConflict, "principal_changed", "Account changed. Reload this page before updating network policy.")
		return
	}
	if _, ok := parseListQuery(w, r); !ok {
		return
	}
	var input networkPolicyInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if !networkActionValid(input.Action) || !browserVersionValid(input.ExpectedResourceVersion) {
		writeError(w, http.StatusBadRequest, "invalid_request", "Network policy selection is invalid")
		return
	}
	requestID, ok := commandRequestID(w, r, actor.OrganizationID, "network-policy")
	if !ok {
		return
	}
	agentID := r.PathValue("agent_id")
	policyID := "builtin/deny-all"
	if input.Action == "allow_all" {
		policyID = "builtin/allow-all"
	}
	payload := map[string]any{"request_id": requestID, "organization_id": actor.OrganizationID, "actor_principal_id": actor.UserID,
		"policy_id": policyID, "revision": 1, "expected_resource_version": input.ExpectedResourceVersion}
	body, err := json.Marshal(payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	result, ok := h.read(w, r, upstream.AgentController, http.MethodPut, "/internal/agents/"+url.PathEscape(agentID)+"/network-policy", "", body)
	if !ok {
		return
	}
	h.writeNetworkPolicy(w, r, result, func(body []byte) ([]byte, error) {
		var assigned networkPolicyAssignmentSource
		if json.Unmarshal(body, &assigned) != nil || assigned.AgentID != agentID || assigned.PolicyID != policyID || assigned.Revision != 1 || !browserVersionValid(assigned.ResourceVersion) ||
			(assigned.ResourceVersion != input.ExpectedResourceVersion && assigned.ResourceVersion != input.ExpectedResourceVersion+1) {
			return nil, fmt.Errorf("invalid policy acknowledgement")
		}
		return json.Marshal(networkPolicyAssignmentView{AgentID: agentID, Action: input.Action, ResourceVersion: assigned.ResourceVersion})
	})
}

func networkPrincipalMatches(r *http.Request, actor principal.Principal) bool {
	raw, err := url.PathUnescape(r.Header.Get("X-Antnest-Expected-Principal"))
	var expected []string
	return err == nil && json.Unmarshal([]byte(raw), &expected) == nil && len(expected) == 2 &&
		expected[0] == actor.OrganizationID && expected[1] == actor.UserID
}

func projectNetworkPolicy(body []byte, agentID string) ([]byte, error) {
	var source struct {
		AgentID string `json:"agent_id"`
		Policy  struct {
			networkPolicyAssignmentSource
			Spec struct {
				SchemaVersion int    `json:"schema_version"`
				Action        string `json:"action"`
			} `json:"spec"`
			Digest string `json:"digest"`
		} `json:"policy"`
		Attachment networkAttachmentView `json:"attachment"`
	}
	if json.Unmarshal(body, &source) != nil || source.AgentID != agentID || !networkPolicyKey.MatchString(source.Policy.PolicyID) || source.Policy.Revision == 0 ||
		!browserVersionValid(source.Policy.ResourceVersion) || source.Policy.Spec.SchemaVersion != 1 || !networkActionValid(source.Policy.Spec.Action) || !networkPolicyDigest.MatchString(source.Policy.Digest) ||
		!browserVersionValid(source.Attachment.ResourceVersion) || (source.Attachment.State != "open" && source.Attachment.State != "closed") {
		return nil, fmt.Errorf("invalid policy read projection")
	}
	return json.Marshal(networkPolicyView{networkPolicyAssignmentView: networkPolicyAssignmentView{AgentID: agentID, Action: source.Policy.Spec.Action, ResourceVersion: source.Policy.ResourceVersion}, Attachment: source.Attachment})
}

func (h *handler) writeNetworkPolicy(w http.ResponseWriter, r *http.Request, result bufferedResponse, project payloadProjector) {
	if result.status == http.StatusOK {
		h.writeProjected(w, r, upstream.AgentController, result, project)
		return
	}
	var failure struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(result.body, &failure) != nil {
		writeError(w, 502, "invalid_upstream_response", "Network policy outcome could not be confirmed")
		return
	}
	status, message := networkPolicyError(failure.Code)
	if status != result.status || status == 0 {
		writeError(w, 502, "invalid_upstream_response", "Network policy outcome could not be confirmed")
		return
	}
	writeError(w, status, failure.Code, message)
}

func networkPolicyError(code string) (int, string) {
	switch code {
	case "invalid_request":
		return 400, "Network policy request is invalid"
	case "agent_not_found":
		return 404, "Agent is no longer available"
	case "agent_network_not_found":
		return 404, "Agent network has not been allocated yet"
	case "policy_revision_not_found":
		return 404, "Network policy is unavailable"
	case "resource_version_conflict":
		return 409, "Network policy changed. Refresh before making a new selection."
	case "agent_network_unavailable":
		return 409, "Agent network is unavailable"
	case "cleanup_failed":
		return 503, "Network cleanup has not completed. The update is not confirmed."
	case "dependency_unavailable":
		return 503, "Network policy outcome could not be confirmed"
	case "dependency_invalid_response":
		return 502, "Network policy outcome could not be confirmed"
	case "internal_error":
		return 500, "Network policy request could not be completed"
	default:
		return 0, ""
	}
}
