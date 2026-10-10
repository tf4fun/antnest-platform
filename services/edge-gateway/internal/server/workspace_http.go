package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

// HTTP/SSE is an opaque ACP transport. Session IDs, queues and connection
// ownership stay in ACP Service, not in a second Gateway session registry.
func (h *handler) relayWorkspaceHTTP(response http.ResponseWriter, request *http.Request, principal identity.Principal) {
	if request.ContentLength > maximumACPMessageBytes {
		writeError(response, http.StatusRequestEntityTooLarge, "invalid_request", "ACP request exceeds the payload limit")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumACPMessageBytes)
	if request.Method != http.MethodGet {
		ctx, cancel := context.WithTimeout(request.Context(), h.requestTimeout)
		defer cancel()
		request = request.WithContext(ctx)
	}
	proxy := &httputil.ReverseProxy{
		Transport:     h.httpClient.Transport,
		FlushInterval: -1,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(h.agentACPURL)
			proxyRequest.Out.URL.Path = "/v1/acp"
			proxyRequest.Out.URL.RawPath, proxyRequest.Out.URL.RawQuery = "", ""
			proxyRequest.Out.Host = h.agentACPURL.Host
			headers := forwardHeaders(proxyRequest, acpRequestHeaders)
			setACPIdentity(headers, principal, request.PathValue("agent_id"))
			identity.ForwardCallerContext(proxyRequest.In.Context(), headers)
			h.forwardingHeaders(headers, proxyRequest.In)
		},
		ModifyResponse: func(upstream *http.Response) error {
			_ = stripCredentialResponse(upstream)
			upstream.Header.Del("Set-Cookie")
			upstream.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "invalid_request", "ACP request exceeds the payload limit")
				return
			}
			h.logger.ErrorContext(r.Context(), "ACP HTTP proxy failed", "error_class", "upstream_unavailable")
			writeError(w, http.StatusServiceUnavailable, "agent_unavailable", "Agent connection is unavailable")
		},
	}
	proxy.ServeHTTP(response, request)
}
