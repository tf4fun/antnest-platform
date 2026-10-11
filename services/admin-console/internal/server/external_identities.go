package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func (h *handler) registerExternalIdentityRoutes() {
	h.mux.HandleFunc("GET /api/admin/directory/identity-providers", h.withPrincipal(h.listExternalIdentityProviders))
	h.mux.HandleFunc("GET /api/admin/directory/memberships/{membership_id}/external-identities", h.withPrincipal(h.listOrganizationExternalIdentities))
	h.mux.HandleFunc("POST /api/admin/directory/memberships/{membership_id}/external-identities", h.withPrincipal(h.bindOrganizationExternalIdentity))
	h.mux.HandleFunc("DELETE /api/admin/directory/memberships/{membership_id}/external-identities/{binding_id}", h.withPrincipal(h.unbindOrganizationExternalIdentity))
}

func externalIdentityListInput(response http.ResponseWriter, request *http.Request) (int, string, bool) {
	response.Header().Set("Cache-Control", "no-store")
	if request.Body != nil {
		body, err := io.ReadAll(io.LimitReader(request.Body, 1))
		if err != nil || len(body) != 0 {
			writeError(response, http.StatusBadRequest, "invalid_request", "Request body is not allowed")
			return 0, "", false
		}
	}
	query, ok := parseListQuery(response, request, "limit", "after_id")
	if !ok {
		return 0, "", false
	}
	limit, err := strconv.Atoi(query.Get("limit"))
	after := query.Get("after_id")
	_, hasAfter := query["after_id"]
	if err != nil || limit < 1 || limit > 100 || strconv.Itoa(limit) != query.Get("limit") || hasAfter && !browserSessionPublicID.MatchString(after) {
		writeInvalidListQuery(response)
		return 0, "", false
	}
	return limit, after, true
}

func externalIdentityPathID(response http.ResponseWriter, request *http.Request, name string) (string, bool) {
	value := request.PathValue(name)
	if !browserSessionPublicID.MatchString(value) {
		writeError(response, http.StatusBadRequest, "invalid_request", "External identity reference is invalid")
		return "", false
	}
	return value, true
}

func (h *handler) listExternalIdentityProviders(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	limit, after, ok := externalIdentityListInput(response, request)
	if !ok {
		return
	}
	input := map[string]any{"actor_principal_id": actor.UserID, "limit": limit}
	if after != "" {
		input["after_id"] = after
	}
	h.forwardExternalIdentity(response, request, "list-external-identity-providers", input, func(body []byte) ([]byte, error) { return projectExternalIdentityProviders(body, after, limit) })
}

func (h *handler) listOrganizationExternalIdentities(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	membership, ok := externalIdentityPathID(response, request, "membership_id")
	if !ok {
		return
	}
	limit, after, ok := externalIdentityListInput(response, request)
	if !ok {
		return
	}
	input := map[string]any{"actor_principal_id": actor.UserID, "scope": "organization", "membership_id": membership, "limit": limit}
	if after != "" {
		input["after_id"] = after
	}
	h.forwardExternalIdentity(response, request, "list-external-identities", input, func(body []byte) ([]byte, error) {
		return projectOrganizationExternalIdentities(body, actor.OrganizationID, membership, after, limit)
	})
}

func decodeExternalIdentityMutation(response http.ResponseWriter, request *http.Request, input any) bool {
	response.Header().Set("Cache-Control", "no-store")
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeInvalidListQuery(response)
		return false
	}
	return decodeJSON(response, request, input)
}

func externalIdentityChoice(raw json.RawMessage) (bool, bool) {
	if raw == nil {
		return false, true
	}
	var value *bool
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return false, false
	}
	return *value, true
}

func (h *handler) bindOrganizationExternalIdentity(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	membership, ok := externalIdentityPathID(response, request, "membership_id")
	if !ok {
		return
	}
	var input struct {
		ProviderID     string          `json:"provider_id"`
		Subject        json.RawMessage `json:"subject"`
		RestoreRevoked json.RawMessage `json:"restore_revoked"`
	}
	if !decodeExternalIdentityMutation(response, request, &input) {
		return
	}
	subject, err := parseExternalIdentitySubject(input.Subject)
	restore, valid := externalIdentityChoice(input.RestoreRevoked)
	if !browserSessionPublicID.MatchString(input.ProviderID) || err != nil || !valid {
		writeError(response, http.StatusBadRequest, "invalid_request", "Provider, subject or restore choice is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "external-identities")
	if !ok {
		return
	}
	payload := map[string]any{"request_id": requestID, "actor_principal_id": actor.UserID, "membership_id": membership, "provider_id": input.ProviderID, "subject": subject, "restore_revoked": restore}
	h.forwardExternalIdentity(response, request, "bind-external-identity", payload, func(body []byte) ([]byte, error) {
		return projectExternalIdentityBinding(body, actor.OrganizationID, membership, input.ProviderID, subject)
	})
}

func (h *handler) unbindOrganizationExternalIdentity(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	membership, ok := externalIdentityPathID(response, request, "membership_id")
	if !ok {
		return
	}
	binding, ok := externalIdentityPathID(response, request, "binding_id")
	if !ok {
		return
	}
	var input struct {
		AllowLockout json.RawMessage `json:"allow_lockout"`
	}
	if !decodeExternalIdentityMutation(response, request, &input) {
		return
	}
	allow, valid := externalIdentityChoice(input.AllowLockout)
	if !valid {
		writeError(response, http.StatusBadRequest, "invalid_request", "Lockout choice is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "external-identities")
	if !ok {
		return
	}
	payload := map[string]any{"request_id": requestID, "actor_principal_id": actor.UserID, "scope": "organization", "membership_id": membership, "binding_id": binding, "allow_lockout": allow}
	// A successful mutation may revoke this CCT. Keep the committed result and
	// let the browser retire the current view without another request or Cookie.
	h.forwardExternalIdentity(response, request, "unbind-external-identity", payload, func(body []byte) ([]byte, error) {
		return projectExternalIdentityUnbind(body, membership == actor.MembershipID)
	})
}

func (h *handler) forwardExternalIdentity(response http.ResponseWriter, request *http.Request, operation string, input any, projector payloadProjector) {
	response.Header().Set("Cache-Control", "no-store")
	body, err := json.Marshal(input)
	if err != nil {
		writeError(response, 500, "encoding_failed", "Request could not be encoded")
		return
	}
	result, ok := h.read(response, request, upstream.Identity, http.MethodPost, "/rpc/identity/"+operation, "", body)
	if !ok {
		return
	}
	if !successful(result.status) {
		var envelope struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(result.body, &envelope)
		status, code, message := http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid"
		switch result.status {
		case 400:
			status, code, message = 400, "invalid_request", "External identity request is invalid"
		case 401:
			status, code, message = 401, "unauthenticated", "Your session is no longer available"
		case 403:
			status, code, message = 403, "forbidden", "External identity access is not allowed"
		case 404:
			status, code, message = 404, "not_found", "External identity reference was not found"
		case 409:
			if operation == "bind-external-identity" && envelope.Code == "external_identity_conflict" {
				status, code, message = 409, envelope.Code, "This external identity is already assigned"
			}
			if operation == "bind-external-identity" && envelope.Code == "external_identity_restore_required" {
				status, code, message = 409, envelope.Code, "This binding was revoked and requires explicit restoration"
			}
			if operation == "unbind-external-identity" && envelope.Code == "external_identity_last_method" {
				status, code, message = 409, envelope.Code, "This is the Membership's last available login method"
			}
		default:
			if result.status >= 500 {
				status, code, message = 503, "dependency_unavailable", "A platform service is unavailable"
			}
		}
		writeError(response, status, code, message)
		return
	}
	h.writeProjected(response, request, upstream.Identity, result, projector)
}
