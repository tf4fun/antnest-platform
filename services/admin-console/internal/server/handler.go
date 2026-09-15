package server

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/providerdiscovery"
	"soft/antnest-platform/services/admin-console/internal/telemetry"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

const (
	maximumRequestBytes        = 2 << 20
	maximumResponseBytes       = 16 << 20
	defaultMemoryBytes         = int64(1 << 30)
	defaultPIDsLimit           = int64(256)
	defaultTmpfsBytes          = int64(256 << 20)
	minimumIdempotencyKeyBytes = 16
	maximumIdempotencyKeyBytes = 200
	defaultBrowserPageSize     = 100
	maximumBrowserPageSize     = 100
	maximumListCursorBytes     = 2048
	minimumPasswordBytes       = 12
	maximumPasswordBytes       = 1024
)

type Backend interface {
	Do(context.Context, upstream.Target, string, string, string, []byte) (*http.Response, error)
}

type Config struct {
	DefaultRuntimeImageRef string
	RequestTimeout         time.Duration
}

type Dependencies struct {
	Backend       Backend
	Assets        fs.FS
	Logger        *slog.Logger
	StreamContext context.Context
}

type handler struct {
	modelLister            providerdiscovery.Lister
	backend                Backend
	assets                 fs.FS
	fileServer             http.Handler
	logger                 *slog.Logger
	defaultRuntimeImageRef string
	requestTimeout         time.Duration
	streamContext          context.Context
	mux                    *http.ServeMux
}

func NewHandler(config Config, dependencies Dependencies) (http.Handler, error) {
	if dependencies.Backend == nil || dependencies.Assets == nil {
		return nil, fmt.Errorf("admin console dependencies are incomplete")
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 15 * time.Second
	}
	if dependencies.StreamContext == nil {
		dependencies.StreamContext = context.Background()
	}
	h := &handler{
		modelLister: providerdiscovery.New(config.RequestTimeout, nil),
		backend:     dependencies.Backend, assets: dependencies.Assets,
		fileServer: http.FileServer(http.FS(dependencies.Assets)), logger: dependencies.Logger,
		defaultRuntimeImageRef: strings.TrimSpace(config.DefaultRuntimeImageRef),
		requestTimeout:         config.RequestTimeout,
		streamContext:          dependencies.StreamContext,
		mux:                    http.NewServeMux(),
	}
	h.routes()
	return h, nil
}

func (h *handler) routes() {
	h.mux.HandleFunc("GET /status", h.status)
	h.mux.HandleFunc("GET /api/admin/overview", h.withPrincipal(h.overview))
	h.mux.HandleFunc("GET /api/admin/execution-audits", h.withPrincipal(h.listExecutionAudits))
	h.mux.HandleFunc("GET /api/admin/execution-audits/{run_id}", h.withPrincipal(h.getExecutionAudit))
	h.mux.HandleFunc("GET /api/admin/execution-audits/{run_id}/events", h.withPrincipal(h.listExecutionAuditEvents))
	h.mux.HandleFunc("GET /api/admin/execution-synchronization", h.withPrincipal(h.getExecutionSynchronization))
	h.mux.HandleFunc("GET /api/admin/template-defaults", h.withPrincipal(h.templateDefaults))
	h.mux.HandleFunc("GET /api/admin/account", h.withPrincipal(h.currentAccount))
	h.mux.HandleFunc("POST /api/admin/account/password", h.withPrincipal(h.changeOwnPassword))
	h.mux.HandleFunc("GET /api/admin/directory", h.withPrincipal(h.directory))
	h.mux.HandleFunc("POST /api/admin/directory/users", h.withPrincipal(h.createLocalUser))
	h.mux.HandleFunc("POST /api/admin/directory/memberships/{membership_id}", h.withPrincipal(h.updateMembership))
	h.mux.HandleFunc("POST /api/admin/directory/users/{user_id}/active", h.withPrincipal(h.setUserActive))
	h.mux.HandleFunc("GET /api/admin/provisioning/oidc-providers", h.withPrincipal(h.listOIDCProviders))
	h.mux.HandleFunc("POST /api/admin/provisioning/oidc-providers", h.withPrincipal(h.upsertOIDCProvider))
	h.mux.HandleFunc("POST /api/admin/provisioning/oidc-providers/{name}/enabled", h.withPrincipal(h.setOIDCProviderEnabled))
	h.mux.HandleFunc("GET /api/admin/provisioning/scim-tokens", h.withPrincipal(h.listSCIMTokens))
	h.mux.HandleFunc("POST /api/admin/provisioning/scim-tokens", h.withPrincipal(h.issueSCIMToken))
	h.mux.HandleFunc("POST /api/admin/provisioning/scim-tokens/{token_id}/revoke", h.withPrincipal(h.revokeSCIMToken))
	h.registerProviderRoutes()
	h.registerCatalogAvailabilityRoutes()
	h.mux.HandleFunc("GET /api/admin/model-catalog", h.withPrincipal(h.modelCatalog))
	h.mux.HandleFunc("GET /api/admin/model-profiles", h.withPrincipal(h.listModelProfiles))
	h.mux.HandleFunc("POST /api/admin/model-profiles", h.withPrincipal(h.createModelProfile))
	h.mux.HandleFunc("GET /api/admin/model-profiles/{model_profile_id}", h.withPrincipal(h.getModelProfile))
	h.mux.HandleFunc("POST /api/admin/model-profiles/{model_profile_id}/revisions", h.withPrincipal(h.reviseModelProfile))
	h.mux.HandleFunc("GET /api/admin/templates", h.withPrincipal(h.listTemplates))
	h.mux.HandleFunc("POST /api/admin/templates", h.withPrincipal(h.createTemplate))
	h.mux.HandleFunc("GET /api/admin/templates/{template_id}", h.withPrincipal(h.getTemplate))
	h.mux.HandleFunc("GET /api/admin/templates/{template_id}/revisions/{revision}", h.withPrincipal(h.getTemplateRevision))
	h.mux.HandleFunc("POST /api/admin/templates/{template_id}/revisions", h.withPrincipal(h.reviseTemplate))
	h.mux.HandleFunc("GET /api/admin/agents", h.withPrincipal(h.listAgents))
	h.mux.HandleFunc("POST /api/admin/agents", h.withPrincipal(h.createAgent))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}", h.withPrincipal(h.getAgent))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}/network-policy", h.withPrincipal(h.getNetworkPolicy))
	h.mux.HandleFunc("PUT /api/admin/agents/{agent_id}/network-policy", h.withPrincipal(h.setNetworkPolicy))
	for _, action := range []string{"rebuild", "disable", "enable", "delete"} {
		h.mux.HandleFunc("POST /api/admin/agents/{agent_id}/"+action, h.withPrincipal(h.lifecycle(action)))
	}
	h.mux.HandleFunc("GET /api/admin/operations/{request_id}", h.withPrincipal(h.getOperation))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}/events", h.withPrincipal(h.listAgentEvents))
	h.mux.HandleFunc("GET /api/admin/agents/{agent_id}/events/watch", h.withPrincipal(h.watchAgentEvents))
	h.mux.HandleFunc("/api/{path...}", func(response http.ResponseWriter, _ *http.Request) {
		writeError(response, http.StatusNotFound, "not_found", "Resource was not found")
	})
	h.mux.HandleFunc("/{path...}", h.application)
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	telemetry.Handler(func(w http.ResponseWriter, r *http.Request) error {
		adapter := &adapterResponse{ResponseWriter: w}
		h.mux.ServeHTTP(adapter, r)
		return adapter.err
	}).ServeHTTP(response, request)
}

type adminHandler func(http.ResponseWriter, *http.Request, principal.Principal)

func (h *handler) withPrincipal(next adminHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, err := principal.FromHeaders(request.Header)
		if err != nil {
			writeError(response, http.StatusUnauthorized, "unauthenticated", "Trusted principal is missing")
			return
		}
		if !actor.Administrator() {
			writeError(response, http.StatusForbidden, "forbidden", "Administrator access is required")
			return
		}
		next(response, request.WithContext(principal.WithContext(request.Context(), actor)), actor)
	}
}

func (h *handler) status(response http.ResponseWriter, _ *http.Request) {
	if h.streamContext.Err() != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (h *handler) templateDefaults(
	response http.ResponseWriter,
	_ *http.Request,
	_ principal.Principal,
) {
	writeJSON(response, http.StatusOK, map[string]string{
		"runtime_image_ref": h.defaultRuntimeImageRef,
	})
}

func (h *handler) directory(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-directory", "", payload, projectDirectory)
}

func (h *handler) currentAccount(
	response http.ResponseWriter,
	request *http.Request,
	actor principal.Principal,
) {
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/get-current-account", "", payload, projectCurrentAccount)
}

type changeOwnPasswordInput struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (h *handler) changeOwnPassword(
	response http.ResponseWriter,
	request *http.Request,
	actor principal.Principal,
) {
	var input changeOwnPasswordInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.CurrentPassword == "" ||
		len(input.NewPassword) < minimumPasswordBytes || len(input.NewPassword) > maximumPasswordBytes {
		writeError(response, http.StatusBadRequest, "invalid_request", "Password fields are invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "account")
	if !ok {
		return
	}
	payload := map[string]string{
		"request_id": requestID, "actor_principal_id": actor.UserID, "user_id": actor.UserID,
		"current_password": input.CurrentPassword, "new_password": input.NewPassword,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	result, ok := h.read(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/change-local-password", "", body)
	if !ok {
		return
	}
	var failure struct {
		Code string `json:"code"`
	}
	if result.status == http.StatusUnauthorized && json.Unmarshal(result.body, &failure) == nil &&
		failure.Code == "unauthenticated" {
		writeError(response, http.StatusUnauthorized, "invalid_current_password", "The current password is incorrect.")
		return
	}
	h.writeProjected(response, request, upstream.Identity, result, projectStatus)
}

type createLocalUserInput struct {
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role"`
}

func (h *handler) createLocalUser(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createLocalUserInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Email, input.DisplayName, input.Password) || !organizationRole(input.Role) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required local user field is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "directory")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"organization_id": actor.OrganizationID, "email": input.Email,
		"display_name": input.DisplayName, "password": input.Password, "role": input.Role,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/create-local-user", "", payload, projectDirectoryMember)
}

type updateMembershipInput struct {
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Active      bool   `json:"active"`
}

func (h *handler) updateMembership(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input updateMembershipInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Email, input.DisplayName) || !organizationRole(input.Role) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required membership field is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "directory")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"organization_id": actor.OrganizationID,
		"membership_id":   request.PathValue("membership_id"),
		"email":           input.Email, "display_name": input.DisplayName,
		"role": input.Role, "active": input.Active,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/update-membership", "", payload, projectMembershipResult)
}

type setUserActiveInput struct {
	Active bool `json:"active"`
}

func (h *handler) setUserActive(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	if !actor.SystemAdministrator() {
		writeError(response, http.StatusForbidden, "forbidden", "System administrator access is required")
		return
	}
	var input setUserActiveInput
	if !decodeJSON(response, request, &input) {
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "directory")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"user_id": request.PathValue("user_id"), "active": input.Active,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/set-user-active", "", payload, projectStatus)
}

func (h *handler) listOIDCProviders(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	if !requireSystemAdministrator(response, actor) {
		return
	}
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-oidc-providers", "", payload, projectOIDCProviderList)
}

type upsertOIDCProviderInput struct {
	Name         string   `json:"name"`
	Issuer       string   `json:"issuer"`
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	Scopes       []string `json:"scopes"`
	Enabled      *bool    `json:"enabled"`
}

func (h *handler) upsertOIDCProvider(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	if !requireSystemAdministrator(response, actor) {
		return
	}
	var input upsertOIDCProviderInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Name, input.Issuer, input.ClientID) || input.Enabled == nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required OIDC Provider field is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "provisioning")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"organization_id": actor.OrganizationID, "name": input.Name,
		"issuer": input.Issuer, "client_id": input.ClientID,
		"client_secret": input.ClientSecret, "scopes": input.Scopes, "enabled": *input.Enabled,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/upsert-oidc-provider", "", payload, projectOIDCProviderResult)
}

type setOIDCProviderEnabledInput struct {
	Enabled *bool `json:"enabled"`
}

func (h *handler) setOIDCProviderEnabled(
	response http.ResponseWriter,
	request *http.Request,
	actor principal.Principal,
) {
	if !requireSystemAdministrator(response, actor) {
		return
	}
	var input setOIDCProviderEnabledInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if input.Enabled == nil {
		writeError(response, http.StatusBadRequest, "invalid_request", "enabled is required")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "provisioning")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"organization_id": actor.OrganizationID,
		"name":            request.PathValue("name"), "enabled": *input.Enabled,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/set-oidc-provider-enabled", "", payload, projectOIDCProviderResult)
}

func (h *handler) listSCIMTokens(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID,
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/list-scim-tokens", "", payload, projectSCIMTokenList)
}

type issueSCIMTokenInput struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
}

func (h *handler) issueSCIMToken(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input issueSCIMTokenInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Name) || !validSCIMScopes(input.Scopes) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required SCIM token field is invalid")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "provisioning")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "actor_principal_id": actor.UserID,
		"organization_id": actor.OrganizationID, "name": input.Name, "scopes": input.Scopes,
	}
	h.forwardProjectedJSONNoStore(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/issue-scim-token", "", payload, projectSCIMTokenIssue)
}

func (h *handler) revokeSCIMToken(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	payload := map[string]string{
		"actor_principal_id": actor.UserID, "token_id": request.PathValue("token_id"),
	}
	h.forwardProjectedJSON(response, request, upstream.Identity, http.MethodPost,
		"/rpc/identity/revoke-scim-token", "", payload, projectStatus)
}

func requireSystemAdministrator(response http.ResponseWriter, actor principal.Principal) bool {
	if actor.SystemAdministrator() {
		return true
	}
	writeError(response, http.StatusForbidden, "forbidden", "System administrator access is required")
	return false
}

func validSCIMScopes(scopes []string) bool {
	if len(scopes) == 0 {
		return false
	}
	for _, scope := range scopes {
		if scope != "scim:read" && scope != "scim:write" {
			return false
		}
	}
	return true
}

func (h *handler) listModelProfiles(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	query, ok := catalogListQuery(response, request, actor.OrganizationID)
	if !ok {
		return
	}
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/model-profiles", query, nil, projectModelProfileList)
}

type createModelProfileInput struct {
	DisplayName          string          `json:"display_name"`
	ProviderConnectionID string          `json:"provider_connection_id"`
	Model                json.RawMessage `json:"model"`
}

func (h *handler) createModelProfile(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createModelProfileInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.DisplayName, input.ProviderConnectionID) || len(input.Model) == 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Model Profile field is empty")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "catalog")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"profile_key": requestID, "display_name": input.DisplayName,
		"model":                  input.Model,
		"provider_connection_id": input.ProviderConnectionID,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/model-profiles", "", payload, projectModelProfile)
}

func (h *handler) getModelProfile(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/model-profiles/"+url.PathEscape(request.PathValue("model_profile_id")),
		organizationScopeQuery(actor.OrganizationID), nil, projectModelProfile)
}

type reviseModelProfileInput struct {
	ExpectedVersion int64           `json:"expected_version"`
	DisplayName     string          `json:"display_name"`
	Model           json.RawMessage `json:"model"`
}

func (h *handler) reviseModelProfile(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input reviseModelProfileInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.DisplayName) || len(input.Model) == 0 || input.ExpectedVersion < 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Model Profile field is empty")
		return
	}
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "catalog")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"display_name": input.DisplayName, "model": input.Model,
		"expected_version": input.ExpectedVersion,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/model-profiles/"+url.PathEscape(request.PathValue("model_profile_id"))+"/revisions",
		"", payload, projectModelProfile)
}

func (h *handler) listTemplates(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	query, ok := catalogListQuery(response, request, actor.OrganizationID)
	if !ok {
		return
	}
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-templates", query, nil, projectTemplateList)
}

type createTemplateInput struct {
	FallbackModelProfileIDs []string     `json:"fallback_model_profile_ids,omitempty"`
	Name                    string       `json:"name"`
	ModelProfileID          string       `json:"model_profile_id"`
	SystemPrompt            string       `json:"system_prompt"`
	MaxModelRequests        int          `json:"max_model_requests,omitempty"`
	Runtime                 runtimeInput `json:"runtime,omitempty"`
}

type runtimeInput struct {
	ImageRef   string          `json:"image_ref,omitempty"`
	Resources  resourceInput   `json:"resources,omitempty"`
	MCPServers json.RawMessage `json:"mcp_servers,omitempty"`
}

type resourceInput struct {
	MemoryBytes int64 `json:"memory_bytes,omitempty"`
	PIDsLimit   int64 `json:"pids_limit,omitempty"`
	TmpfsBytes  int64 `json:"tmpfs_bytes,omitempty"`
}

func (h *handler) createTemplate(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createTemplateInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Name, input.ModelProfileID) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Template field is empty")
		return
	}
	if input.MaxModelRequests == 0 {
		input.MaxModelRequests = 32
	}
	if input.Runtime.ImageRef == "" {
		input.Runtime.ImageRef = h.defaultRuntimeImageRef
	}
	if input.Runtime.ImageRef == "" {
		writeError(response, http.StatusBadRequest, "runtime_image_required", "Select a Runtime image tag")
		return
	}
	applyResourceDefaults(&input.Runtime.Resources)
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "catalog")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"template_key": requestID, "name": input.Name,
		"fallback_model_profile_ids": append([]string{}, input.FallbackModelProfileIDs...),
		"model_profile_id":           input.ModelProfileID,
		"system_prompt":              input.SystemPrompt, "max_model_requests": input.MaxModelRequests,
		"context_policy_version": "context-v1", "runtime": input.Runtime,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/agent-templates", "", payload, projectTemplate)
}

func (h *handler) getTemplate(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-templates/"+url.PathEscape(request.PathValue("template_id")),
		organizationScopeQuery(actor.OrganizationID), nil, projectTemplate)
}

func (h *handler) getTemplateRevision(
	response http.ResponseWriter, request *http.Request, actor principal.Principal,
) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-templates/"+url.PathEscape(request.PathValue("template_id"))+
			"/revisions/"+url.PathEscape(request.PathValue("revision")),
		organizationScopeQuery(actor.OrganizationID), nil, projectTemplate)
}

type reviseTemplateInput struct {
	FallbackModelProfileIDs []string     `json:"fallback_model_profile_ids,omitempty"`
	Name                    string       `json:"name"`
	ModelProfileID          string       `json:"model_profile_id"`
	SystemPrompt            string       `json:"system_prompt"`
	MaxModelRequests        int          `json:"max_model_requests"`
	Runtime                 runtimeInput `json:"runtime"`
}

func (h *handler) reviseTemplate(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input reviseTemplateInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.Name, input.ModelProfileID) || input.MaxModelRequests < 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Template field is invalid")
		return
	}
	if input.Runtime.ImageRef == "" {
		input.Runtime.ImageRef = h.defaultRuntimeImageRef
	}
	if input.Runtime.ImageRef == "" {
		writeError(response, http.StatusBadRequest, "runtime_image_required", "Select a Runtime image tag")
		return
	}
	applyResourceDefaults(&input.Runtime.Resources)
	requestID, ok := commandRequestID(response, request, actor.OrganizationID, "catalog")
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"name": input.Name, "model_profile_id": input.ModelProfileID,
		"fallback_model_profile_ids": append([]string{}, input.FallbackModelProfileIDs...),
		"system_prompt":              input.SystemPrompt, "max_model_requests": input.MaxModelRequests,
		"context_policy_version": "context-v1", "runtime": input.Runtime,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/agent-templates/"+url.PathEscape(request.PathValue("template_id"))+"/revisions",
		"", payload, projectTemplate)
}

func (h *handler) listAgents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	query, ok := agentListQuery(response, request, actor.OrganizationID)
	if !ok {
		return
	}
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents", query, nil, projectAgentList)
}

type createAgentInput struct {
	OwnerUserID      string `json:"owner_user_id"`
	Name             string `json:"name"`
	TemplateID       string `json:"template_id"`
	TemplateRevision int64  `json:"template_revision"`
}

func (h *handler) createAgent(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	var input createAgentInput
	if !decodeJSON(response, request, &input) {
		return
	}
	if !required(input.OwnerUserID, input.Name, input.TemplateID) || input.TemplateRevision < 1 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Required Agent field is invalid")
		return
	}
	requestID, ok := lifecycleRequestID(response, request, actor.OrganizationID)
	if !ok {
		return
	}
	payload := map[string]any{
		"request_id": requestID, "organization_id": actor.OrganizationID,
		"actor_principal_id": actor.UserID,
		"owner_user_id":      input.OwnerUserID, "name": input.Name,
		"template_id": input.TemplateID, "template_revision": input.TemplateRevision,
	}
	h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
		"/internal/agents", "", payload, projectCreateAgent)
}

func (h *handler) getAgent(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(request.PathValue("agent_id")),
		url.Values{"organization_id": []string{actor.OrganizationID}}.Encode(), nil, projectAgent)
}

func (h *handler) lifecycle(action string) adminHandler {
	return func(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
		agentID := request.PathValue("agent_id")
		requestID, ok := lifecycleRequestID(response, request, actor.OrganizationID)
		if !ok {
			return
		}
		payload := map[string]any{
			"request_id": requestID, "organization_id": actor.OrganizationID,
			"actor_principal_id": actor.UserID,
		}
		if action == "rebuild" {
			var input struct {
				TemplateID       string `json:"template_id"`
				TemplateRevision int64  `json:"template_revision"`
			}
			if !decodeJSON(response, request, &input) {
				return
			}
			if !required(input.TemplateID) || input.TemplateRevision < 1 {
				writeError(response, http.StatusBadRequest, "invalid_request", "Template revision is required")
				return
			}
			payload["template_id"] = input.TemplateID
			payload["template_revision"] = input.TemplateRevision
		} else if !decodeEmptyObject(response, request) {
			return
		}
		h.forwardProjectedJSON(response, request, upstream.AgentController, http.MethodPost,
			"/internal/agents/"+url.PathEscape(agentID)+"/"+action, "", payload, projectOperation)
	}
}

func (h *handler) getOperation(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agent-operations/"+url.PathEscape(request.PathValue("request_id")),
		url.Values{"organization_id": []string{actor.OrganizationID}}.Encode(), nil, projectOperation)
}

func (h *handler) listAgentEvents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	agentID := request.PathValue("agent_id")
	queryValues := eventQueryValues(request.URL.Query())
	queryValues.Set("organization_id", actor.OrganizationID)
	h.forwardProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(agentID)+"/events", queryValues.Encode(), nil, projectAgentEventList)
}

func (h *handler) watchAgentEvents(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	agentID := request.PathValue("agent_id")
	queryValues, ok := eventWatchQueryValues(request.URL.Query(), request.Header.Values("Last-Event-ID"))
	if !ok {
		writeInvalidListQuery(response)
		return
	}
	queryValues.Set("organization_id", actor.OrganizationID)
	h.streamProjected(response, request, upstream.AgentController, http.MethodGet,
		"/internal/agents/"+url.PathEscape(agentID)+"/events/watch",
		queryValues.Encode(), nil, projectAgentEvent)
}

func (h *handler) overview(response http.ResponseWriter, request *http.Request, actor principal.Principal) {
	calls := []overviewCall{
		{target: upstream.Identity, method: http.MethodPost, path: "/rpc/identity/list-directory",
			body: map[string]string{"actor_principal_id": actor.UserID, "organization_id": actor.OrganizationID},
			name: "directory", projector: projectDirectory},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/model-profiles",
			query: organizationQuery(actor.OrganizationID), name: "model_profiles", projector: projectModelProfileList},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/agent-templates",
			query: organizationQuery(actor.OrganizationID), name: "templates", projector: projectTemplateList},
		{target: upstream.AgentController, method: http.MethodGet, path: "/internal/agents",
			query: url.Values{"organization_id": []string{actor.OrganizationID}, "limit": []string{"200"}}.Encode(),
			name:  "agents", projector: projectAgentList},
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	results := h.fetchOverview(ctx, calls)
	agents := overviewSectionFromResult("Agent inventory", results["agents"])
	if agents.Error != nil {
		writeFailure(response, agents.Error.Status, agents.Error.Code, agents.Error.Message, results["agents"].err)
		return
	}
	payload := overviewResponse{
		Directory:     overviewSectionFromResult("Directory", results["directory"]),
		ModelProfiles: overviewSectionFromResult("Model providers", results["model_profiles"]),
		Templates:     overviewSectionFromResult("Agent templates", results["templates"]),
		Agents:        agents,
		Defaults:      map[string]string{"runtime_image_ref": h.defaultRuntimeImageRef},
	}
	writeJSON(response, http.StatusOK, payload)
}

type overviewCall struct {
	target    upstream.Target
	method    string
	path      string
	query     string
	body      any
	name      string
	projector payloadProjector
}

type overviewCallResult struct {
	response bufferedResponse
	err      error
}

type overviewError struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type overviewSection struct {
	Status string          `json:"status"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  *overviewError  `json:"error,omitempty"`
}

type overviewResponse struct {
	Directory     overviewSection   `json:"directory"`
	ModelProfiles overviewSection   `json:"model_profiles"`
	Templates     overviewSection   `json:"templates"`
	Agents        overviewSection   `json:"agents"`
	Defaults      map[string]string `json:"defaults"`
}

func (h *handler) fetchOverview(ctx context.Context, calls []overviewCall) map[string]overviewCallResult {
	results := make(map[string]overviewCallResult, len(calls))
	var mutex sync.Mutex
	var group sync.WaitGroup
	group.Add(len(calls))
	for _, item := range calls {
		call := item
		go func() {
			defer group.Done()
			var body []byte
			var err error
			if call.body != nil {
				body, err = json.Marshal(call.body)
			}
			var result bufferedResponse
			if err == nil {
				result, err = h.fetchBuffered(ctx, call.target, call.method, call.path, call.query, body)
			}
			if err == nil && successful(result.status) && call.projector != nil {
				result.body, err = call.projector(result.body)
				if err != nil {
					err = &bufferedFetchError{
						status: http.StatusBadGateway, code: "invalid_upstream_response",
						message: "Platform response is invalid", cause: err,
					}
				}
			}
			mutex.Lock()
			results[call.name] = overviewCallResult{response: result, err: err}
			mutex.Unlock()
		}()
	}
	group.Wait()
	return results
}

func overviewSectionFromResult(label string, result overviewCallResult) overviewSection {
	if result.err == nil && successful(result.response.status) {
		return overviewSection{Status: "available", Data: json.RawMessage(result.response.body)}
	}
	failure := overviewError{
		Status: result.response.status, Code: "upstream_rejected", Message: label + " could not be refreshed",
	}
	if result.err != nil {
		failure.Status, failure.Code = http.StatusServiceUnavailable, "dependency_unavailable"
		var fetchError *bufferedFetchError
		if errors.As(result.err, &fetchError) {
			failure.Status, failure.Code = fetchError.status, fetchError.code
		}
	}
	switch failure.Status {
	case http.StatusForbidden:
		failure.Message = label + ": access is not allowed"
	case http.StatusNotFound:
		failure.Message = label + ": resource not found"
	case http.StatusGone:
		failure.Message = label + ": resource is no longer available"
	}
	if failure.Status < http.StatusBadRequest || failure.Status > 599 {
		failure.Status = http.StatusBadGateway
	}
	return overviewSection{Status: "unavailable", Error: &failure}
}

func successful(status int) bool {
	return status >= http.StatusOK && status < http.StatusMultipleChoices
}

type bufferedResponse struct {
	status int
	header http.Header
	body   []byte
}

func (h *handler) forwardProjectedJSON(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	payload any,
	projector payloadProjector,
) {
	body, err := json.Marshal(payload)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_failed", "Request could not be encoded")
		return
	}
	h.forwardProjected(response, request, target, method, path, query, body, projector)
}

func (h *handler) forwardProjectedJSONNoStore(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	payload any,
	projector payloadProjector,
) {
	response.Header().Set("Cache-Control", "no-store")
	h.forwardProjectedJSON(response, request, target, method, path, query, payload, projector)
}

func (h *handler) forwardProjected(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
	projector payloadProjector,
) {
	result, ok := h.read(response, request, target, method, path, query, body)
	if !ok {
		return
	}
	h.writeProjected(response, request, target, result, projector)
}

func (h *handler) writeProjected(
	response http.ResponseWriter,
	_ *http.Request,
	_ upstream.Target,
	result bufferedResponse,
	projector payloadProjector,
) {
	if successful(result.status) {
		retainFailure(response, protocolFailure(result.body))
	}
	if successful(result.status) {
		projected, err := projector(result.body)
		if err != nil {
			writeFailure(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid", err)
			return
		}
		result.body = projected
		result.header.Set("Content-Type", "application/json")
	}
	result.header.Set("Cache-Control", "no-store")
	writeRaw(response, result.status, result.header, result.body)
}

func (h *handler) read(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
) (bufferedResponse, bool) {
	ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
	defer cancel()
	result, err := h.fetchBuffered(ctx, target, method, path, query, body)
	if err != nil {
		var failure *bufferedFetchError
		if errors.As(err, &failure) {
			writeFailure(response, failure.status, failure.code, failure.message, err)
		} else {
			writeFailure(response, http.StatusServiceUnavailable, "dependency_unavailable", "A platform service is unavailable", err)
		}
		return bufferedResponse{}, false
	}
	return result, true
}

type bufferedFetchError struct {
	status  int
	code    string
	message string
	cause   error
}

func (failure *bufferedFetchError) Error() string { return failure.message }

func (failure *bufferedFetchError) Unwrap() error { return failure.cause }

func (h *handler) fetchBuffered(
	ctx context.Context,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
) (bufferedResponse, error) {
	upstreamResponse, err := h.backend.Do(ctx, target, method, path, query, body)
	if err != nil {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusServiceUnavailable, code: "dependency_unavailable",
			message: "A platform service is unavailable", cause: err,
		}
	}
	if upstreamResponse == nil || upstreamResponse.Body == nil {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusBadGateway, code: "invalid_upstream_response",
			message: "Platform response is invalid",
		}
	}
	defer func() { _ = upstreamResponse.Body.Close() }()
	payload, readErr := io.ReadAll(io.LimitReader(upstreamResponse.Body, maximumResponseBytes+1))
	if readErr != nil || len(payload) > maximumResponseBytes {
		return bufferedResponse{}, &bufferedFetchError{
			status: http.StatusBadGateway, code: "invalid_upstream_response",
			message: "Platform response is invalid", cause: readErr,
		}
	}
	return bufferedResponse{
		status: upstreamResponse.StatusCode, header: upstreamResponse.Header.Clone(), body: payload,
	}, nil
}

func (h *handler) streamProjected(
	response http.ResponseWriter,
	request *http.Request,
	target upstream.Target,
	method string,
	path string,
	query string,
	body []byte,
	projector payloadProjector,
) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "streaming_unavailable", "Streaming is unavailable")
		return
	}
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	stop := context.AfterFunc(h.streamContext, cancel)
	defer stop()
	if h.streamContext.Err() != nil {
		writeError(response, http.StatusServiceUnavailable, "service_stopping", "Console is stopping")
		return
	}
	request = request.WithContext(ctx)
	stopWrites := h.cancelStreamWrites(ctx, response)
	defer stopWrites()
	upstreamResponse, err := h.backend.Do(request.Context(), target, method, path, query, body)
	if err != nil {
		writeFailure(response, http.StatusServiceUnavailable, "dependency_unavailable", "A platform service is unavailable", err)
		return
	}
	if upstreamResponse == nil || upstreamResponse.Body == nil {
		writeError(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid")
		return
	}
	defer func() { _ = upstreamResponse.Body.Close() }()
	if !successful(upstreamResponse.StatusCode) {
		payload, readErr := io.ReadAll(io.LimitReader(upstreamResponse.Body, maximumResponseBytes+1))
		if readErr != nil || len(payload) > maximumResponseBytes {
			writeError(response, http.StatusBadGateway, "invalid_upstream_response", "Platform response is invalid")
			return
		}
		writeRaw(response, upstreamResponse.StatusCode, upstreamResponse.Header, payload)
		return
	}
	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	response.WriteHeader(upstreamResponse.StatusCode)
	flusher.Flush()
	scanner := bufio.NewScanner(upstreamResponse.Body)
	scanner.Buffer(make([]byte, 16<<10), maximumResponseBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if payload, found := strings.CutPrefix(string(line), "data: "); found {
			projected, projectErr := projector([]byte(payload))
			if projectErr != nil {
				retainFailure(response, &adapterFailure{status: 502, code: "invalid_upstream_response", message: "Event projection is invalid", cause: projectErr})
				return
			}
			line = append([]byte("data: "), projected...)
		}
		if _, err := response.Write(append(line, '\n')); err != nil {
			return
		}
		if len(line) == 0 {
			flusher.Flush()
		}
	}
	if err := scanner.Err(); err != nil && request.Context().Err() == nil {
		retainFailure(response, &adapterFailure{status: 502, code: "invalid_upstream_response", message: "Event stream ended unexpectedly", cause: err})
	}
}

func (h *handler) application(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}
	clean := strings.TrimPrefix(path.Clean("/"+request.URL.Path), "/")
	if clean != "" && clean != "." {
		if info, err := fs.Stat(h.assets, clean); err == nil && !info.IsDir() {
			h.fileServer.ServeHTTP(response, request)
			return
		}
	}
	index, err := fs.ReadFile(h.assets, "index.html")
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "application_unavailable", "Console application is unavailable")
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache")
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = response.Write(index)
	}
}

func decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type must be application/json")
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, maximumRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeFailure(response, http.StatusBadRequest, "invalid_request", "Request body is invalid", err)
		return false
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body must contain one object")
		return false
	}
	return true
}

func decodeEmptyObject(response http.ResponseWriter, request *http.Request) bool {
	var payload map[string]json.RawMessage
	if !decodeJSON(response, request, &payload) {
		return false
	}
	if len(payload) != 0 {
		writeError(response, http.StatusBadRequest, "invalid_request", "Request body must be empty")
		return false
	}
	return true
}

func applyResourceDefaults(resources *resourceInput) {
	if resources.MemoryBytes == 0 {
		resources.MemoryBytes = defaultMemoryBytes
	}
	if resources.PIDsLimit == 0 {
		resources.PIDsLimit = defaultPIDsLimit
	}
	if resources.TmpfsBytes == 0 {
		resources.TmpfsBytes = defaultTmpfsBytes
	}
}

func organizationQuery(organizationID string) string {
	return url.Values{"organization_id": []string{organizationID}, "limit": []string{"200"}}.Encode()
}

func organizationScopeQuery(organizationID string) string {
	return url.Values{"organization_id": []string{organizationID}}.Encode()
}

func catalogListQuery(response http.ResponseWriter, request *http.Request, organizationID string) (string, bool) {
	input, ok := parseListQuery(response, request, "after_id", "limit")
	if !ok {
		return "", false
	}
	query, ok := browserPageQuery(response, input, organizationID)
	if !ok {
		return "", false
	}
	if !copyBoundedListValue(response, query, input, "after_id") {
		return "", false
	}
	return query.Encode(), true
}

func agentListQuery(response http.ResponseWriter, request *http.Request, organizationID string) (string, bool) {
	input, ok := parseListQuery(response, request, "view", "cursor", "limit")
	if !ok {
		return "", false
	}
	query, ok := browserPageQuery(response, input, organizationID)
	if !ok || !copyBoundedListValue(response, query, input, "cursor") {
		return "", false
	}
	view := input.Get("view")
	if view != "" && view != "current" && view != "deleted" {
		writeInvalidListQuery(response)
		return "", false
	}
	if view == "deleted" {
		query.Set("include_deleted", "true")
		query.Set("lifecycle_state", "deleted")
	}
	return query.Encode(), true
}

func parseListQuery(response http.ResponseWriter, request *http.Request, allowed ...string) (url.Values, bool) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		writeInvalidListQuery(response)
		return nil, false
	}
	allowedNames := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allowedNames[name] = struct{}{}
	}
	for name, entries := range values {
		if _, ok := allowedNames[name]; !ok || len(entries) != 1 {
			writeInvalidListQuery(response)
			return nil, false
		}
	}
	return values, true
}

func browserPageQuery(response http.ResponseWriter, input url.Values, organizationID string) (url.Values, bool) {
	limit := defaultBrowserPageSize
	if rawLimit, present := input["limit"]; present {
		parsed, err := strconv.Atoi(rawLimit[0])
		if err != nil || parsed < 1 || parsed > maximumBrowserPageSize {
			writeInvalidListQuery(response)
			return nil, false
		}
		limit = parsed
	}
	return url.Values{
		"organization_id": []string{organizationID},
		"limit":           []string{strconv.Itoa(limit)},
	}, true
}

func copyBoundedListValue(response http.ResponseWriter, output, input url.Values, name string) bool {
	values, present := input[name]
	if !present {
		return true
	}
	if values[0] == "" || len(values[0]) > maximumListCursorBytes {
		writeInvalidListQuery(response)
		return false
	}
	output.Set(name, values[0])
	return true
}

func writeInvalidListQuery(response http.ResponseWriter) {
	writeError(response, http.StatusBadRequest, "invalid_request", "List query is invalid")
}

func eventQueryValues(input url.Values) url.Values {
	result := url.Values{}
	if value := input.Get("after_sequence"); value != "" {
		if sequence, err := strconv.ParseInt(value, 10, 64); err == nil && sequence >= 0 {
			result.Set("after_sequence", value)
		}
	}
	result.Set("limit", "200")
	return result
}

func eventWatchQueryValues(input url.Values, lastEventIDs []string) (url.Values, bool) {
	result := url.Values{}
	if len(lastEventIDs) > 1 {
		return nil, false
	}
	if len(lastEventIDs) == 1 {
		sequence, err := strconv.ParseInt(strings.TrimSpace(lastEventIDs[0]), 10, 64)
		if err != nil || sequence < 0 {
			return nil, false
		}
		// Backend calls carry no browser headers; translate the reconnect cursor.
		result.Set("after_sequence", strconv.FormatInt(sequence, 10))
		return result, true
	}
	if value := input.Get("after_sequence"); value != "" {
		if sequence, err := strconv.ParseInt(value, 10, 64); err == nil && sequence >= 0 {
			result.Set("after_sequence", value)
		}
	}
	return result, true
}

func required(values ...string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return false
		}
	}
	return true
}

func organizationRole(value string) bool {
	return value == "member" || value == "admin"
}

func writeRaw(response http.ResponseWriter, status int, header http.Header, payload []byte) {
	copyResponseHeaders(response.Header(), header)
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

func copyResponseHeaders(target, source http.Header) {
	for _, name := range []string{"Content-Type", "Cache-Control", "ETag", "Last-Modified"} {
		for _, value := range source.Values(name) {
			target.Add(name, value)
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeFailure(response, status, code, message, nil)
}

func commandRequestID(
	response http.ResponseWriter, request *http.Request, organizationID, namespace string,
) (string, bool) {
	key := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if len(key) < minimumIdempotencyKeyBytes || len(key) > maximumIdempotencyKeyBytes ||
		strings.IndexFunc(key, func(value rune) bool { return value < 0x21 || value > 0x7e }) >= 0 {
		writeError(response, http.StatusBadRequest, "invalid_idempotency_key", "A valid Idempotency-Key is required")
		return "", false
	}
	digest := sha256.Sum256([]byte(organizationID + "\x00" + key))
	return namespace + "-" + hex.EncodeToString(digest[:]), true
}

func lifecycleRequestID(
	response http.ResponseWriter, request *http.Request, organizationID string,
) (string, bool) {
	return commandRequestID(response, request, organizationID, "lifecycle")
}
