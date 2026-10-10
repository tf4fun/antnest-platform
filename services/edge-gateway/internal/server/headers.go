package server

import (
	"net/http"
	"net/http/httputil"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

// The profiles are specified by contracts/edge-gateway/request-headers.json.
// Identity, tracing, workload authentication and forwarding metadata are added
// independently of browser fields, after this allowlist has been applied.
var (
	assetRequestHeaders = []string{
		"Accept", "Accept-Encoding", "Cache-Control", "If-Match", "If-None-Match",
		"If-Modified-Since", "If-Unmodified-Since", "If-Range", "Range",
	}
	jsonRequestHeaders     = []string{"Accept", "Content-Type", "If-Match", "Idempotency-Key"}
	eventRequestHeaders    = []string{"Accept", "Last-Event-ID"}
	documentRequestHeaders = []string{"Accept"}
	acpRequestHeaders      = []string{"Accept", "Content-Type", "Acp-Connection-Id", "Acp-Session-Id"}
	scimRequestHeaders     = []string{"Accept", "Content-Type", "Authorization", "If-Match", "If-None-Match"}
)

func forwardHeaders(request *httputil.ProxyRequest, names []string) http.Header {
	headers := make(http.Header)
	for _, name := range names {
		// ReverseProxy has already removed hop-by-hop fields from Out. Reading
		// In here would restore browser fields nominated by Connection.
		for _, value := range request.Out.Header.Values(name) {
			headers.Add(name, value)
		}
	}
	request.Out.Header = headers
	// Inbound trailers are populated at EOF, independently of Header. Do not
	// share their map with the outgoing transport even before values arrive.
	request.Out.Trailer = nil
	return headers
}

func consoleHeaders(request *httputil.ProxyRequest, authenticated bool) http.Header {
	if !authenticated {
		return forwardHeaders(request, assetRequestHeaders)
	}
	profile := jsonRequestHeaders
	if isAgentEventWatch(request.In) {
		profile = eventRequestHeaders
	}
	headers := forwardHeaders(request, profile)
	if principal, ok := identity.FromContext(request.In.Context()); ok {
		setPrincipalHeaders(headers, principal)
		identity.ForwardCallerContext(request.In.Context(), headers)
	}
	if isNetworkPolicyUpdate(request.In) {
		if value, ok := request.In.Context().Value(validatedPrincipalPreconditionKey{}).(string); ok {
			headers.Set(principalPreconditionHeader, value)
		}
	}
	return headers
}
