package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
	"soft/antnest-platform/services/identity-service/internal/oidcflow"
	"soft/antnest-platform/services/identity-service/internal/scim"
)

const maxRequestBytes = 1 << 20

var ContractRoutes = map[string]string{
	"list_principal_revocations":  "/rpc/identity/list-principal-revocations",
	"create_organization":         "/rpc/identity/create-organization",
	"create_local_user":           "/rpc/identity/create-local-user",
	"add_organization_membership": "/rpc/identity/add-organization-membership",
	"change_local_password":       "/rpc/identity/change-local-password",
	"update_membership":           "/rpc/identity/update-membership",
	"set_user_active":             "/rpc/identity/set-user-active",
	"list_directory":              "/rpc/identity/list-directory",
	"get_current_account":         "/rpc/identity/get-current-account",
	"resolve_principal":           "/rpc/identity/resolve-principal",
	"local_login":                 "/rpc/identity/local-login",
	"resolve_access_token":        "/rpc/identity/resolve-access-token",
	"revoke_access_token":         "/rpc/identity/revoke-access-token",
	"issue_scim_token":            "/rpc/identity/issue-scim-token",
	"revoke_scim_token":           "/rpc/identity/revoke-scim-token",
	"list_scim_tokens":            "/rpc/identity/list-scim-tokens",
	"upsert_oidc_provider":        "/rpc/identity/upsert-oidc-provider",
	"set_oidc_provider_enabled":   "/rpc/identity/set-oidc-provider-enabled",
	"list_oidc_providers":         "/rpc/identity/list-oidc-providers",
	"list_login_methods":          "/rpc/identity/list-login-methods",
	"start_oidc_login":            "/rpc/identity/start-oidc-login",
}

type DirectoryService interface {
	ListPrincipalRevocations(context.Context, directory.RevocationQuery) (domain.PrincipalRevocationPage, error)
	CreateOrganization(context.Context, directory.CreateOrganizationInput) (domain.Organization, error)
	CreateLocalUser(context.Context, directory.CreateLocalUserInput) (directory.CreateLocalUserResult, error)
	AddOrganizationMembership(context.Context, directory.AddOrganizationMembershipInput) (domain.OrganizationMembership, error)
	ChangeLocalPassword(context.Context, directory.ChangeLocalPasswordInput) error
	UpdateMembership(context.Context, directory.UpdateMembershipInput) (domain.OrganizationMembership, error)
	SetUserActive(context.Context, directory.SetUserActiveInput) error
	List(context.Context, string, string) (directory.Directory, error)
	GetCurrentAccount(context.Context, string, string) (directory.CurrentAccount, error)
	ResolvePrincipal(context.Context, string, string) (domain.Principal, error)
}

type LocalAuthService interface {
	Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error)
	Resolve(context.Context, string) (domain.Principal, error)
	RevokeByAccessToken(context.Context, string) (localauth.RevokeStatus, error)
}

type OIDCService interface {
	UpsertProvider(context.Context, oidcflow.UpsertProviderInput) (oidcflow.Provider, error)
	SetProviderEnabled(context.Context, oidcflow.SetProviderEnabledInput) (oidcflow.Provider, error)
	ListProviders(context.Context, string, string) ([]oidcflow.Provider, error)
	ListLoginMethods(context.Context, string) ([]oidcflow.LoginMethod, error)
	StartLogin(context.Context, oidcflow.StartLoginInput) (oidcflow.StartLoginResult, error)
	CompleteLogin(context.Context, oidcflow.CompleteLoginInput) (oidcflow.CompleteLoginResult, error)
}

type SCIMService interface {
	IssueToken(context.Context, scim.IssueTokenInput) (scim.IssueTokenResult, error)
	RevokeToken(context.Context, string, string) error
	ListTokens(context.Context, string, string) ([]scim.Token, error)
}

type Dependencies struct {
	Directory DirectoryService
	LocalAuth LocalAuthService
	OIDC      OIDCService
	SCIM      SCIMService
}

type Handler struct {
	dependencies Dependencies
	mux          *http.ServeMux
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Directory == nil || dependencies.LocalAuth == nil ||
		dependencies.OIDC == nil || dependencies.SCIM == nil {
		return nil, fmt.Errorf("identity RPC handler requires all application services")
	}
	handler := &Handler{dependencies: dependencies, mux: http.NewServeMux()}
	handler.mux.HandleFunc("POST /rpc/identity/list-principal-revocations", handler.listPrincipalRevocations)
	handler.mux.HandleFunc("POST /rpc/identity/create-organization", handler.createOrganization)
	handler.mux.HandleFunc("POST /rpc/identity/create-local-user", handler.createLocalUser)
	handler.mux.HandleFunc("POST /rpc/identity/add-organization-membership", handler.addOrganizationMembership)
	handler.mux.HandleFunc("POST /rpc/identity/change-local-password", handler.changeLocalPassword)
	handler.mux.HandleFunc("POST /rpc/identity/update-membership", handler.updateMembership)
	handler.mux.HandleFunc("POST /rpc/identity/set-user-active", handler.setUserActive)
	handler.mux.HandleFunc("POST /rpc/identity/list-directory", handler.listDirectory)
	handler.mux.HandleFunc("POST /rpc/identity/get-current-account", handler.getCurrentAccount)
	handler.mux.HandleFunc("POST /rpc/identity/resolve-principal", handler.resolvePrincipal)
	handler.mux.HandleFunc("POST /rpc/identity/local-login", handler.localLogin)
	handler.mux.HandleFunc("POST /rpc/identity/resolve-access-token", handler.resolveAccessToken)
	handler.mux.HandleFunc("POST /rpc/identity/revoke-access-token", handler.revokeAccessToken)
	handler.mux.HandleFunc("POST /rpc/identity/issue-scim-token", handler.issueSCIMToken)
	handler.mux.HandleFunc("POST /rpc/identity/revoke-scim-token", handler.revokeSCIMToken)
	handler.mux.HandleFunc("POST /rpc/identity/list-scim-tokens", handler.listSCIMTokens)
	handler.mux.HandleFunc("POST /rpc/identity/upsert-oidc-provider", handler.upsertOIDCProvider)
	handler.mux.HandleFunc("POST /rpc/identity/set-oidc-provider-enabled", handler.setOIDCProviderEnabled)
	handler.mux.HandleFunc("POST /rpc/identity/list-oidc-providers", handler.listOIDCProviders)
	handler.mux.HandleFunc("POST /rpc/identity/list-login-methods", handler.listLoginMethods)
	handler.mux.HandleFunc("POST /rpc/identity/start-oidc-login", handler.startOIDCLogin)
	handler.mux.HandleFunc("GET /protocol/oidc/callback", handler.oidcCallback)
	return handler, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.mux.ServeHTTP(response, request)
}

type createOrganizationRequest struct {
	RequestID        string `json:"request_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	Slug             string `json:"slug"`
	Name             string `json:"name"`
	OwnerEmail       string `json:"owner_email"`
	OwnerDisplayName string `json:"owner_display_name"`
}

func (h *Handler) createOrganization(response http.ResponseWriter, request *http.Request) {
	var body createOrganizationRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.OwnerEmail, body.OwnerDisplayName) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID) {
		return
	}
	organization, err := h.dependencies.Directory.CreateOrganization(request.Context(), directory.CreateOrganizationInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, Slug: body.Slug, Name: body.Name,
		OwnerEmail: body.OwnerEmail, OwnerDisplayName: body.OwnerDisplayName,
	})
	writeResult(response, map[string]any{"organization": organization}, err)
}

type createLocalUserRequest struct {
	RequestID        string                  `json:"request_id"`
	ActorPrincipalID string                  `json:"actor_principal_id"`
	OrganizationID   string                  `json:"organization_id"`
	Email            string                  `json:"email"`
	DisplayName      string                  `json:"display_name"`
	Password         string                  `json:"password"`
	Role             domain.OrganizationRole `json:"role"`
}

func (h *Handler) createLocalUser(response http.ResponseWriter, request *http.Request) {
	var body createLocalUserRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	result, err := h.dependencies.Directory.CreateLocalUser(request.Context(), directory.CreateLocalUserInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, OrganizationID: body.OrganizationID,
		Email: body.Email, DisplayName: body.DisplayName, Password: body.Password, Role: body.Role,
	})
	writeResult(response, result, err)
}

type addOrganizationMembershipRequest struct {
	RequestID        string                  `json:"request_id"`
	ActorPrincipalID string                  `json:"actor_principal_id"`
	OrganizationID   string                  `json:"organization_id"`
	UserID           string                  `json:"user_id"`
	Email            string                  `json:"email"`
	DisplayName      string                  `json:"display_name"`
	Role             domain.OrganizationRole `json:"role"`
}

func (h *Handler) addOrganizationMembership(response http.ResponseWriter, request *http.Request) {
	var body addOrganizationMembershipRequest
	if !decodeRequest(response, request, &body) || !require(
		response,
		body.Email,
		body.DisplayName,
	) || !requireIDs(response, body.RequestID, body.ActorPrincipalID, body.OrganizationID, body.UserID) {
		return
	}
	membership, err := h.dependencies.Directory.AddOrganizationMembership(
		request.Context(),
		directory.AddOrganizationMembershipInput{
			RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
			OrganizationID: body.OrganizationID, UserID: body.UserID,
			Email: body.Email, DisplayName: body.DisplayName, Role: body.Role,
		},
	)
	writeResult(response, map[string]any{"membership": membership}, err)
}

type changeLocalPasswordRequest struct {
	RequestID        string `json:"request_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	UserID           string `json:"user_id"`
	CurrentPassword  string `json:"current_password"`
	NewPassword      string `json:"new_password"`
}

func (h *Handler) changeLocalPassword(response http.ResponseWriter, request *http.Request) {
	var body changeLocalPasswordRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.CurrentPassword, body.NewPassword) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.UserID) {
		return
	}
	err := h.dependencies.Directory.ChangeLocalPassword(request.Context(), directory.ChangeLocalPasswordInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID, UserID: body.UserID,
		CurrentPassword: body.CurrentPassword, NewPassword: body.NewPassword,
	})
	writeResult(response, map[string]string{"status": "changed"}, err)
}

type updateMembershipRequest struct {
	RequestID        string                  `json:"request_id"`
	ActorPrincipalID string                  `json:"actor_principal_id"`
	OrganizationID   string                  `json:"organization_id"`
	MembershipID     string                  `json:"membership_id"`
	Email            string                  `json:"email"`
	DisplayName      string                  `json:"display_name"`
	Role             domain.OrganizationRole `json:"role"`
	Active           *bool                   `json:"active"`
}

func (h *Handler) updateMembership(response http.ResponseWriter, request *http.Request) {
	var body updateMembershipRequest
	if !decodeRequest(response, request, &body) || !require(
		response,
		body.Email,
		body.DisplayName,
	) || !requireIDs(
		response, body.RequestID, body.ActorPrincipalID, body.OrganizationID, body.MembershipID,
	) {
		return
	}
	if body.Active == nil {
		writeError(response, domain.NewError("bad_request", "active is required", false))
		return
	}
	membership, err := h.dependencies.Directory.UpdateMembership(request.Context(), directory.UpdateMembershipInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID: body.OrganizationID, MembershipID: body.MembershipID,
		Email: body.Email, DisplayName: body.DisplayName, Role: body.Role, Active: *body.Active,
	})
	writeResult(response, map[string]any{"membership": membership}, err)
}

type setUserActiveRequest struct {
	RequestID        string `json:"request_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	UserID           string `json:"user_id"`
	Active           *bool  `json:"active"`
}

func (h *Handler) setUserActive(response http.ResponseWriter, request *http.Request) {
	var body setUserActiveRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.UserID) {
		return
	}
	if body.Active == nil {
		writeError(response, domain.NewError("bad_request", "active is required", false))
		return
	}
	err := h.dependencies.Directory.SetUserActive(request.Context(), directory.SetUserActiveInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
		UserID: body.UserID, Active: *body.Active,
	})
	writeResult(response, map[string]string{"status": "updated"}, err)
}

type directoryRequest struct {
	ActorPrincipalID string `json:"actor_principal_id"`
	OrganizationID   string `json:"organization_id"`
}

func (h *Handler) listDirectory(response http.ResponseWriter, request *http.Request) {
	var body directoryRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	result, err := h.dependencies.Directory.List(request.Context(), body.ActorPrincipalID, body.OrganizationID)
	writeResult(response, result, err)
}

func (h *Handler) getCurrentAccount(response http.ResponseWriter, request *http.Request) {
	var body directoryRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	account, err := h.dependencies.Directory.GetCurrentAccount(
		request.Context(), body.ActorPrincipalID, body.OrganizationID,
	)
	writeResult(response, map[string]any{"account": account}, err)
}

type resolvePrincipalRequest struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
}

type organizationPrincipalBinding struct {
	UserID         string `json:"user_id"`
	OrganizationID string `json:"organization_id"`
	MembershipID   string `json:"membership_id"`
	Active         bool   `json:"active"`
}

func (h *Handler) resolvePrincipal(response http.ResponseWriter, request *http.Request) {
	var body resolvePrincipalRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.UserID, body.OrganizationID) {
		return
	}
	principal, err := h.dependencies.Directory.ResolvePrincipal(
		request.Context(), body.UserID, body.OrganizationID,
	)
	writeResult(response, map[string]any{"principal": organizationPrincipalBinding{
		UserID: principal.UserID, OrganizationID: principal.OrganizationID,
		MembershipID: principal.MembershipID, Active: principal.Active,
	}}, err)
}

type localLoginRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationSlug string `json:"organization_slug"`
	Email            string `json:"email"`
	Password         string `json:"password"`
}

func (h *Handler) localLogin(response http.ResponseWriter, request *http.Request) {
	var body localLoginRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.OrganizationSlug, body.Email, body.Password) ||
		!requireIDs(response, body.RequestID) {
		return
	}
	result, err := h.dependencies.LocalAuth.Login(request.Context(), localauth.LoginInput{
		RequestID: body.RequestID, OrganizationSlug: body.OrganizationSlug,
		Email: body.Email, Password: body.Password,
	})
	writeResult(response, result, err)
}

type resolveTokenRequest struct {
	AccessToken string `json:"access_token"`
}

func (h *Handler) resolveAccessToken(response http.ResponseWriter, request *http.Request) {
	var body resolveTokenRequest
	if !decodeRequest(response, request, &body) || !require(response, body.AccessToken) {
		return
	}
	principal, err := h.dependencies.LocalAuth.Resolve(request.Context(), body.AccessToken)
	writeResult(response, map[string]any{"principal": principal}, err)
}

type revokeAccessTokenRequest struct {
	AccessToken string `json:"access_token"`
}

func (h *Handler) revokeAccessToken(response http.ResponseWriter, request *http.Request) {
	var body revokeAccessTokenRequest
	if !decodeRequest(response, request, &body) || !require(response, body.AccessToken) {
		return
	}
	status, err := h.dependencies.LocalAuth.RevokeByAccessToken(
		request.Context(), body.AccessToken,
	)
	writeResult(response, map[string]localauth.RevokeStatus{"status": status}, err)
}

type revokeTokenRequest struct {
	ActorPrincipalID string `json:"actor_principal_id"`
	TokenID          string `json:"token_id"`
}

type issueSCIMTokenRequest struct {
	RequestID        string   `json:"request_id"`
	ActorPrincipalID string   `json:"actor_principal_id"`
	OrganizationID   string   `json:"organization_id"`
	Name             string   `json:"name"`
	Scopes           []string `json:"scopes"`
}

func (h *Handler) issueSCIMToken(response http.ResponseWriter, request *http.Request) {
	var body issueSCIMTokenRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.Name) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	result, err := h.dependencies.SCIM.IssueToken(request.Context(), scim.IssueTokenInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID: body.OrganizationID, Name: body.Name, Scopes: body.Scopes,
	})
	writeResult(response, result, err)
}

func (h *Handler) revokeSCIMToken(response http.ResponseWriter, request *http.Request) {
	var body revokeTokenRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.TokenID) {
		return
	}
	err := h.dependencies.SCIM.RevokeToken(request.Context(), body.ActorPrincipalID, body.TokenID)
	writeResult(response, map[string]string{"status": "revoked"}, err)
}

type provisioningListRequest struct {
	ActorPrincipalID string `json:"actor_principal_id"`
	OrganizationID   string `json:"organization_id"`
}

func (h *Handler) listSCIMTokens(response http.ResponseWriter, request *http.Request) {
	var body provisioningListRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	tokens, err := h.dependencies.SCIM.ListTokens(
		request.Context(), body.ActorPrincipalID, body.OrganizationID,
	)
	if tokens == nil {
		tokens = []scim.Token{}
	}
	writeResult(response, map[string]any{"tokens": tokens}, err)
}

type upsertOIDCProviderRequest struct {
	RequestID        string   `json:"request_id"`
	ActorPrincipalID string   `json:"actor_principal_id"`
	OrganizationID   string   `json:"organization_id"`
	Name             string   `json:"name"`
	Issuer           string   `json:"issuer"`
	ClientID         string   `json:"client_id"`
	ClientSecret     string   `json:"client_secret"`
	Scopes           []string `json:"scopes"`
	Enabled          *bool    `json:"enabled"`
}

func (h *Handler) upsertOIDCProvider(response http.ResponseWriter, request *http.Request) {
	var body upsertOIDCProviderRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.Name, body.Issuer, body.ClientID) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	if body.Enabled == nil {
		writeError(response, domain.NewError("bad_request", "enabled is required", false))
		return
	}
	provider, err := h.dependencies.OIDC.UpsertProvider(request.Context(), oidcflow.UpsertProviderInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID: body.OrganizationID, Name: body.Name, Issuer: body.Issuer,
		ClientID: body.ClientID, ClientSecret: body.ClientSecret,
		Scopes: body.Scopes, Enabled: *body.Enabled,
	})
	writeResult(response, map[string]any{"provider": provider}, err)
}

type setOIDCProviderEnabledRequest struct {
	RequestID        string `json:"request_id"`
	ActorPrincipalID string `json:"actor_principal_id"`
	OrganizationID   string `json:"organization_id"`
	Name             string `json:"name"`
	Enabled          *bool  `json:"enabled"`
}

func (h *Handler) setOIDCProviderEnabled(response http.ResponseWriter, request *http.Request) {
	var body setOIDCProviderEnabledRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.Name) ||
		!requireIDs(response, body.RequestID, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	if body.Enabled == nil {
		writeError(response, domain.NewError("bad_request", "enabled is required", false))
		return
	}
	provider, err := h.dependencies.OIDC.SetProviderEnabled(request.Context(), oidcflow.SetProviderEnabledInput{
		RequestID: body.RequestID, ActorPrincipalID: body.ActorPrincipalID,
		OrganizationID: body.OrganizationID, Name: body.Name, Enabled: *body.Enabled,
	})
	writeResult(response, map[string]any{"provider": provider}, err)
}

func (h *Handler) listOIDCProviders(response http.ResponseWriter, request *http.Request) {
	var body provisioningListRequest
	if !decodeRequest(response, request, &body) ||
		!requireIDs(response, body.ActorPrincipalID, body.OrganizationID) {
		return
	}
	providers, err := h.dependencies.OIDC.ListProviders(
		request.Context(), body.ActorPrincipalID, body.OrganizationID,
	)
	if providers == nil {
		providers = []oidcflow.Provider{}
	}
	writeResult(response, map[string]any{"providers": providers}, err)
}

type organizationSlugRequest struct {
	OrganizationSlug string `json:"organization_slug"`
}

func (h *Handler) listLoginMethods(response http.ResponseWriter, request *http.Request) {
	var body organizationSlugRequest
	if !decodeRequest(response, request, &body) || !require(response, body.OrganizationSlug) {
		return
	}
	methods, err := h.dependencies.OIDC.ListLoginMethods(request.Context(), body.OrganizationSlug)
	if methods == nil {
		methods = []oidcflow.LoginMethod{}
	}
	writeResult(response, map[string]any{"methods": methods}, err)
}

type startOIDCLoginRequest struct {
	RequestID        string `json:"request_id"`
	OrganizationSlug string `json:"organization_slug"`
	ProviderName     string `json:"provider_name"`
}

func (h *Handler) startOIDCLogin(response http.ResponseWriter, request *http.Request) {
	var body startOIDCLoginRequest
	if !decodeRequest(response, request, &body) ||
		!require(response, body.OrganizationSlug, body.ProviderName) ||
		!requireIDs(response, body.RequestID) {
		return
	}
	result, err := h.dependencies.OIDC.StartLogin(request.Context(), oidcflow.StartLoginInput{
		RequestID: body.RequestID, OrganizationSlug: body.OrganizationSlug, ProviderName: body.ProviderName,
	})
	writeResult(response, result, err)
}

func (h *Handler) oidcCallback(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	state := strings.TrimSpace(request.URL.Query().Get("state"))
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	authorizationError := strings.TrimSpace(request.URL.Query().Get("error"))
	if state == "" {
		writeError(response, domain.NewError("bad_request", "state is required", false))
		return
	}
	if len(authorizationError) > 256 {
		writeError(response, domain.NewError("bad_request", "OIDC authorization error is invalid", false))
		return
	}
	result, err := h.dependencies.OIDC.CompleteLogin(request.Context(), oidcflow.CompleteLoginInput{
		State: state, Code: code, AuthorizationError: authorizationError,
	})
	writeResult(response, result, err)
}

func decodeRequest(response http.ResponseWriter, request *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(response, domain.NewError("bad_request", "Request body is invalid", false))
		return false
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(response, domain.NewError("bad_request", "Request body must contain one JSON object", false))
		return false
	}
	return true
}

func require(response http.ResponseWriter, values ...string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			writeError(response, domain.NewError("bad_request", "Required request field is empty", false))
			return false
		}
	}
	return true
}

func requireIDs(response http.ResponseWriter, values ...string) bool {
	for _, value := range values {
		if !domain.ValidID(value) {
			writeError(response, domain.NewError("bad_request", "Identity field is invalid", false))
			return false
		}
	}
	return true
}

func writeResult(response http.ResponseWriter, value any, err error) {
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, value)
}

func writeError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code, message, retryable := domain.ErrorDetails(err)
	switch {
	case errors.Is(err, domain.ErrInvalidArgument):
		status = http.StatusBadRequest
	case errors.Is(err, domain.ErrUnauthenticated):
		status = http.StatusUnauthorized
	case errors.Is(err, domain.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, domain.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, domain.ErrConflict):
		status = http.StatusConflict
	case errors.Is(err, domain.ErrLastOrganizationAdmin):
		status = http.StatusConflict
	case errors.Is(err, domain.ErrVersionConflict):
		status = http.StatusConflict
	case errors.Is(err, domain.ErrInvalidReference):
		status = http.StatusBadRequest
	}
	switch code {
	case "bad_request", "oidc_authorization_failed", "oidc_exchange_claim_invalid", "oidc_session_failed":
		status = http.StatusBadRequest
	case "inactive_principal", "oidc_membership_required":
		status = http.StatusForbidden
	case "oidc_provider_changed", "oidc_provider_issuer_immutable", "oidc_provider_client_id_immutable", "oidc_exchange_in_progress":
		status = http.StatusConflict
	case "oidc_session_expired", "oidc_completed_token_unavailable":
		status = http.StatusGone
	}
	writeJSON(response, status, map[string]any{"code": code, "message": message, "retryable": retryable})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
