package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type csrfKey struct{}
type principalPreconditionKey struct{}
type validatedPrincipalPreconditionKey struct{}

const principalPreconditionHeader = "X-Antnest-Expected-Principal"

func stripBrowserCredentials(request *http.Request) {
	var csrf, principalPrecondition []string
	for name, values := range request.Header {
		if strings.EqualFold(name, session.CSRFHeaderName) {
			csrf = append(csrf, values...)
		}
		if strings.EqualFold(name, principalPreconditionHeader) {
			principalPrecondition = append(principalPrecondition, values...)
		}
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") ||
			strings.HasPrefix(strings.ToLower(name), "antnest-") {
			delete(request.Header, name)
		}
	}
	ctx := context.WithValue(request.Context(), csrfKey{}, csrf)
	ctx = context.WithValue(ctx, principalPreconditionKey{}, principalPrecondition)
	*request = *request.WithContext(ctx)
}

func isNetworkPolicyUpdate(request *http.Request) bool {
	parts := strings.Split(request.URL.EscapedPath(), "/")
	return request.Method == http.MethodPut && len(parts) == 6 && parts[1] == "api" && parts[2] == "admin" && parts[3] == "agents" && parts[5] == "network-policy"
}

// The browser's account-switch guard is compared with authenticated Identity
// facts. Store the validated canonical result separately from the raw input;
// only the owning proxy operation may inject it after hop-by-hop filtering.
func validateNetworkPrincipalPrecondition(request *http.Request, principal identity.Principal) bool {
	if !isNetworkPolicyUpdate(request) {
		return true
	}
	values, _ := request.Context().Value(principalPreconditionKey{}).([]string)
	if len(values) != 1 || len(values[0]) > 8192 {
		return false
	}
	raw, err := url.PathUnescape(values[0])
	if err != nil || !utf8.ValidString(raw) {
		return false
	}
	var expected []string
	if json.Unmarshal([]byte(raw), &expected) != nil || len(expected) != 2 || expected[0] != principal.OrganizationID || expected[1] != principal.UserID {
		return false
	}
	canonical, err := json.Marshal([]string{principal.OrganizationID, principal.UserID})
	if err != nil {
		return false
	}
	ctx := context.WithValue(request.Context(), validatedPrincipalPreconditionKey{}, url.PathEscape(string(canonical)))
	*request = *request.WithContext(ctx)
	return true
}

func (h *handler) validCSRF(request *http.Request, sessionID string) bool {
	csrf, _ := request.Context().Value(csrfKey{}).([]string)
	if len(csrf) != 1 {
		return false
	}
	local := request.Clone(request.Context())
	local.Header.Set(session.CSRFHeaderName, csrf[0])
	return h.sessions.ValidCSRF(local, sessionID)
}

func callerSelection(request *http.Request) (string, string) {
	profile := "workspace"
	agent := request.PathValue("agent_id")
	if request.PathValue("acp_version") != "" {
		profile = "acp"
	}
	if strings.HasPrefix(request.URL.Path, "/api/admin/") {
		profile = "console"
		if strings.HasPrefix(request.URL.Path, "/api/admin/agents/") {
			agent = pathAgent(request.URL, 4)
		}
	} else if strings.HasPrefix(request.URL.Path, "/api/app/workspace/v1/") {
		agent, _ = workspaceBridgeAgentID(request.PathValue("path"))
	}
	return profile, agent
}

func pathAgent(target *url.URL, index int) string {
	parts := strings.Split(target.EscapedPath(), "/")
	if len(parts) <= index {
		return ""
	}
	agent, err := url.PathUnescape(parts[index])
	if err != nil || !validWorkspaceReturnID(agent) {
		return ""
	}
	return agent
}

func stripCredentialResponse(response *http.Response) error {
	for name := range response.Header {
		// HSTS belongs to the public Gateway, including ReverseProxy's raw 101 path.
		if strings.EqualFold(name, serviceauth.Header) || strings.EqualFold(name, identity.CallerContextHeader) || strings.EqualFold(name, "Strict-Transport-Security") {
			delete(response.Header, name)
		}
	}
	return nil
}
