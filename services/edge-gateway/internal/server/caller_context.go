package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type csrfKey struct{}

func stripBrowserCredentials(request *http.Request) {
	var csrf []string
	for name, values := range request.Header {
		if strings.EqualFold(name, session.CSRFHeaderName) {
			csrf = append(csrf, values...)
		}
		if strings.HasPrefix(strings.ToLower(name), "x-antnest-") ||
			strings.EqualFold(name, serviceauth.Header) || strings.EqualFold(name, identity.CallerContextHeader) {
			delete(request.Header, name)
		}
	}
	*request = *request.WithContext(context.WithValue(request.Context(), csrfKey{}, csrf))
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
