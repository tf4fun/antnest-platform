package rpc

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func externalScope(response http.ResponseWriter, request *http.Request, scope string) bool {
	if scope != "self" && scope != "organization" {
		writeError(response, domain.InvalidArgument("scope must be self or organization"))
		return false
	}
	workload, _ := request.Context().Value(workloadKey{}).(string)
	if scope == "self" && workload == "edge-gateway" || scope == "organization" && workload == "admin-console" {
		return true
	}
	writeError(response, domain.ErrForbidden)
	return false
}
func externalOptionalID(response http.ResponseWriter, raw json.RawMessage, target *string) bool {
	if raw == nil {
		return true
	}
	if json.Unmarshal(raw, target) != nil || !domain.ValidID(*target) {
		writeError(response, domain.InvalidArgument("optional reference must be a non-null public ID"))
		return false
	}
	return true
}
func externalOptionalBoolean(response http.ResponseWriter, raw json.RawMessage, target *bool) bool {
	if raw == nil {
		return true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, target) != nil {
		writeError(response, domain.InvalidArgument("optional flag must be a non-null Boolean"))
		return false
	}
	return true
}
func externalMembership(response http.ResponseWriter, scope string, raw json.RawMessage, target *string) bool {
	if scope == "self" && raw != nil || scope == "organization" && raw == nil {
		writeError(response, domain.InvalidArgument("membership_id is required only for organization scope"))
		return false
	}
	return externalOptionalID(response, raw, target)
}

func (h *Handler) listExternalIdentities(response http.ResponseWriter, request *http.Request) {
	var body struct {
		ActorPrincipalID string          `json:"actor_principal_id"`
		Scope            string          `json:"scope"`
		MembershipID     json.RawMessage `json:"membership_id"`
		Limit            *int            `json:"limit"`
		AfterID          json.RawMessage `json:"after_id"`
		NoticeAfterID    json.RawMessage `json:"notice_after_id"`
	}
	if !decodeRequest(response, request, &body) || !externalScope(response, request, body.Scope) {
		return
	}
	input := externalidentities.ListInput{ActorPrincipalID: body.ActorPrincipalID, Scope: body.Scope}
	if body.Limit == nil || body.Scope == "organization" && body.NoticeAfterID != nil {
		writeError(response, domain.InvalidArgument("limit is required; notice pagination is self-only"))
		return
	}
	input.Limit = *body.Limit
	if !externalMembership(response, body.Scope, body.MembershipID, &input.MembershipID) || !externalOptionalID(response, body.AfterID, &input.AfterID) || !externalOptionalID(response, body.NoticeAfterID, &input.NoticeAfterID) {
		return
	}
	result, err := h.dependencies.ExternalIdentities.List(request.Context(), input)
	writeResult(response, result, err)
}

func (h *Handler) bindExternalIdentity(response http.ResponseWriter, request *http.Request) {
	var body struct {
		RequestID        string          `json:"request_id"`
		ActorPrincipalID string          `json:"actor_principal_id"`
		MembershipID     string          `json:"membership_id"`
		ProviderID       string          `json:"provider_id"`
		Subject          json.RawMessage `json:"subject"`
		RestoreRevoked   json.RawMessage `json:"restore_revoked"`
	}
	if !decodeRequest(response, request, &body) {
		return
	}
	input := externalidentities.BindInput{RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, MembershipID: body.MembershipID, ProviderID: body.ProviderID}
	var err error
	input.Subject, err = oidcflow.ParseSubjectJSON(body.Subject)
	if err != nil {
		writeError(response, domain.InvalidArgument("subject must be a valid opaque string"))
		return
	}
	if !externalOptionalBoolean(response, body.RestoreRevoked, &input.RestoreRevoked) {
		return
	}
	result, err := h.dependencies.ExternalIdentities.Bind(request.Context(), input)
	writeResult(response, map[string]any{"binding": result}, err)
}

func (h *Handler) unbindExternalIdentity(response http.ResponseWriter, request *http.Request) {
	var body struct {
		RequestID        string          `json:"request_id"`
		ActorPrincipalID string          `json:"actor_principal_id"`
		BindingID        string          `json:"binding_id"`
		MembershipID     json.RawMessage `json:"membership_id"`
		Scope            string          `json:"scope"`
		AllowLockout     json.RawMessage `json:"allow_lockout"`
	}
	if !decodeRequest(response, request, &body) || !externalScope(response, request, body.Scope) {
		return
	}
	input := externalidentities.UnbindInput{RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, BindingID: body.BindingID, Scope: body.Scope}
	if !externalMembership(response, body.Scope, body.MembershipID, &input.MembershipID) || !externalOptionalBoolean(response, body.AllowLockout, &input.AllowLockout) {
		return
	}
	result, err := h.dependencies.ExternalIdentities.Unbind(request.Context(), input)
	writeResult(response, result, err)
}

func (h *Handler) acknowledgeExternalIdentityNotices(response http.ResponseWriter, request *http.Request) {
	var body struct {
		RequestID        string   `json:"request_id"`
		ActorPrincipalID string   `json:"actor_principal_id"`
		NoticeIDs        []string `json:"notice_ids"`
	}
	if !decodeRequest(response, request, &body) {
		return
	}
	result, err := h.dependencies.ExternalIdentities.Acknowledge(request.Context(), externalidentities.AcknowledgeInput{RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, NoticeIDs: body.NoticeIDs})
	writeResult(response, result, err)
}

func (h *Handler) listExternalIdentityProviders(response http.ResponseWriter, request *http.Request) {
	var body struct {
		ActorPrincipalID string          `json:"actor_principal_id"`
		Limit            *int            `json:"limit"`
		AfterID          json.RawMessage `json:"after_id"`
	}
	if !decodeRequest(response, request, &body) {
		return
	}
	if body.Limit == nil {
		writeError(response, domain.InvalidArgument("limit is required"))
		return
	}
	input := externalidentities.ProvidersInput{ActorPrincipalID: body.ActorPrincipalID, Limit: *body.Limit}
	if !externalOptionalID(response, body.AfterID, &input.AfterID) {
		return
	}
	result, err := h.dependencies.ExternalIdentities.ListProviders(request.Context(), input)
	writeResult(response, result, err)
}
