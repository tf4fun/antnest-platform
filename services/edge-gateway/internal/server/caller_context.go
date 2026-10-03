package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type csrfKey struct{}
type principalPreconditionKey struct{}

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
			strings.EqualFold(name, serviceauth.Header) || strings.EqualFold(name, identity.CallerContextHeader) {
			delete(request.Header, name)
		}
	}
	ctx := context.WithValue(request.Context(), csrfKey{}, csrf)
	ctx = context.WithValue(ctx, principalPreconditionKey{}, principalPrecondition)
	*request = *request.WithContext(ctx)
}

// The browser's account-switch guard is compared with authenticated Identity
// facts. Only this operation receives a regenerated, canonical precondition.
func restoreNetworkPrincipalPrecondition(request *http.Request, principal identity.Principal) bool {
	parts := strings.Split(request.URL.EscapedPath(), "/")
	if request.Method != http.MethodPut || len(parts) != 6 || parts[1] != "api" || parts[2] != "admin" || parts[3] != "agents" || parts[5] != "network-policy" {
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
	request.Header.Set(principalPreconditionHeader, url.PathEscape(string(canonical)))
	return true
}

func (h *handler) validCSRF(request *http.Request, values session.Values) bool {
	csrf, _ := request.Context().Value(csrfKey{}).([]string)
	if len(csrf) != 1 {
		return false
	}
	local := request.Clone(request.Context())
	local.Header.Set(session.CSRFHeaderName, csrf[0])
	return h.sessions.ValidCSRF(local, values)
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
		if strings.EqualFold(name, serviceauth.Header) || strings.EqualFold(name, identity.CallerContextHeader) {
			delete(response.Header, name)
		}
	}
	return nil
}
