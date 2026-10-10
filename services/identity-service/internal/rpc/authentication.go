package rpc

import (
	"context"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

// Exact handlers and their policies are checked against the owning caller catalog.
var routeCallers = map[string][]string{
	"/rpc/identity/touch-browser-session":       {"edge-gateway"},
	"/rpc/identity/list-user-sessions":          {"edge-gateway", "admin-console"},
	"/rpc/identity/revoke-user-sessions":        {"edge-gateway", "admin-console"},
	"/rpc/identity/list-session-revocations":    {"edge-gateway"},
	"/rpc/identity/resolve-owner-authorization": {"agent-controller"},
	"/rpc/identity/list-principal-revocations":  {"agent-controller"},
	"/rpc/identity/resolve-principal":           {"agent-controller"},
	"/rpc/identity/create-organization":         {"admin-console"},
	"/rpc/identity/create-local-user":           {"admin-console"},
	"/rpc/identity/add-organization-membership": {"admin-console"},
	"/rpc/identity/change-local-password":       {"edge-gateway"},
	"/rpc/identity/update-membership":           {"admin-console"},
	"/rpc/identity/set-user-active":             {"admin-console"},
	"/rpc/identity/list-directory":              {"admin-console"},
	"/rpc/identity/get-current-account":         {"edge-gateway", "admin-console"},
	"/rpc/identity/issue-scim-token":            {"admin-console"},
	"/rpc/identity/revoke-scim-token":           {"admin-console"},
	"/rpc/identity/list-scim-tokens":            {"admin-console"},
	"/rpc/identity/upsert-oidc-provider":        {"admin-console"},
	"/rpc/identity/set-oidc-provider-enabled":   {"admin-console"},
	"/rpc/identity/list-oidc-providers":         {"admin-console"},
	"/rpc/identity/local-login":                 {"edge-gateway"},
	"/rpc/identity/resolve-access-token":        {"edge-gateway"},
	"/rpc/identity/revoke-access-token":         {"edge-gateway"},
	"/rpc/identity/list-login-methods":          {"edge-gateway"},
	"/rpc/identity/start-oidc-login":            {"edge-gateway"},
	"/protocol/oidc/callback":                   {"edge-gateway"},
	"/rpc/identity/jwks":                        {"edge-gateway", "admin-console", "agent-ui", "agent-acp-service", "agent-controller", "skill-registry"},
}

type claimsKey struct{}

func requiresCallerContext(path, workload string) bool {
	if path == "/rpc/identity/jwks" {
		return false
	}
	if workload == "admin-console" {
		return true
	}
	switch path {
	case "/rpc/identity/touch-browser-session", "/rpc/identity/list-user-sessions", "/rpc/identity/revoke-user-sessions", "/rpc/identity/change-local-password", "/rpc/identity/get-current-account":
		return true
	default:
		return false
	}
}

func (h *Handler) authenticate(response http.ResponseWriter, request *http.Request) (*http.Request, bool) {
	callers := routeCallers[request.URL.Path]
	caller, failure := h.dependencies.Authentication.Authorize(request, callers)
	if failure != nil {
		writeError(response, failure)
		return request, false
	}
	response.Header().Set("Cache-Control", "no-store")
	if !requiresCallerContext(request.URL.Path, caller) {
		return request, true
	}
	values := request.Header.Values(callercontext.Header)
	if len(values) == 0 {
		writeError(response, domain.NewError("caller_context_required", "Authenticated caller context is required", false))
		return request, false
	}
	if len(values) != 1 || values[0] == "" {
		writeError(response, callercontext.ErrInvalid)
		return request, false
	}
	authenticated, err := h.dependencies.CallerContext.AuthenticateSession(request.Context(), values[0])
	if err != nil {
		writeError(response, err)
		return request, false
	}
	claims := authenticated.Claims()
	ctx := callercontext.WithCaller(request.Context(), authenticated)
	ctx = domain.WithCallerOrganization(ctx, claims.Organization)
	return request.WithContext(context.WithValue(ctx, claimsKey{}, claims)), true
}

func (h *Handler) jwks(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, h.dependencies.CallerContext.PublicJWKS())
}
