package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"soft/antnest-platform/services/edge-gateway/internal/identity"
)

const workspaceBridgeRequestTimeout = 65 * time.Second

func (h *handler) workspaceBridgeAPI(response http.ResponseWriter, request *http.Request) error {
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return nil
	}
	if request.Header.Get("Origin") != "" && !sameOrigin(request) {
		writeError(response, http.StatusForbidden, "forbidden", "Workspace origin is not allowed")
		return nil
	}
	path := request.PathValue("path")
	agentID, valid := workspaceBridgeAgentID(path)
	if !valid {
		writeError(response, http.StatusNotFound, "not_found", "Workspace route was not found")
		return nil
	}
	values, principal, err := h.authenticate(response, request)
	if err != nil {
		return err
	}
	request.Header.Set(HeaderOrganizationID, principal.OrganizationID)
	request.Header.Set(HeaderPrincipalID, principal.UserID)
	request.Header.Set(HeaderUserID, principal.UserID)
	request.Header.Set(HeaderMembershipID, principal.MembershipID)
	if principal.Administrator() {
		request.Header.Set(HeaderAdministrator, "true")
	} else {
		request.Header.Set(HeaderAdministrator, "false")
	}
	if agentID != "" {
		request.Header.Set(HeaderAgentID, agentID)
	} else {
		request.Header.Del(HeaderAgentID)
	}
	if strings.HasSuffix(path, "/events") {
		if request.Method != http.MethodGet || path != "agents/"+agentID+"/events" {
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
			return nil
		}
		return h.workspaceBridgeEvents(response, request, values.AccessToken, principal)
	}
	if request.Method == http.MethodPost && !h.sessions.ValidCSRF(request, values) {
		writeError(response, http.StatusForbidden, "csrf_failed", "Request could not be verified")
		return nil
	}
	if request.ContentLength > maximumACPMessageBytes {
		writeError(response, http.StatusRequestEntityTooLarge, "request_too_large", "Workspace request exceeds the payload limit")
		return nil
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumACPMessageBytes)
	ctx, cancel := context.WithTimeout(request.Context(), workspaceBridgeRequestTimeout)
	defer cancel()
	h.workspaceBridgeProxy.ServeHTTP(response, request.WithContext(ctx))
	return nil
}

func (h *handler) workspaceBridgeEvents(response http.ResponseWriter, request *http.Request, token string, principal identity.Principal) error {
	lastIDs := request.Header.Values("Last-Event-ID")
	if len(lastIDs) > 1 || (len(lastIDs) == 1 && (len(lastIDs[0]) > 4096 ||
		strings.ContainsAny(lastIDs[0], "\r\n\x00"))) {
		writeError(response, http.StatusUnprocessableEntity, "invalid_request", "Event cursor is invalid")
		return nil
	}
	select {
	case h.bridgeStreams <- struct{}{}:
		defer func() { <-h.bridgeStreams }()
	default:
		writeError(response, http.StatusServiceUnavailable, "workspace_unavailable", "Workspace stream capacity is unavailable")
		return nil
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.streamLease)
	defer cancel()
	done := make(chan struct{})
	interval := min(h.streamLease/4, 30*time.Second)
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if h.validateStateIdentity(ctx, token, principal) != nil {
					cancel()
					return
				}
			}
		}
	}()
	h.workspaceBridgeProxy.ServeHTTP(response, request.WithContext(ctx))
	cancel()
	<-done
	return nil
}

func workspaceBridgeAgentID(path string) (string, bool) {
	if path == "bootstrap" {
		return "", true
	}
	parts := strings.Split(path, "/")
	if len(parts) < 3 || parts[0] != "agents" || parts[1] == "" ||
		len(parts[1]) > 200 || strings.ContainsAny(parts[1], "\\\x00\r\n") {
		return "", false
	}
	return parts[1], true
}

func (h *handler) newWorkspaceBridgeProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{
		Transport:     h.httpClient.Transport,
		FlushInterval: -1,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(target)
			proxyRequest.Out.Host = target.Host
			headers := make(http.Header)
			for _, name := range []string{
				"Accept", "Content-Type", "If-Match", "Idempotency-Key", "Last-Event-ID",
				HeaderOrganizationID, HeaderPrincipalID, HeaderUserID,
				HeaderMembershipID, HeaderAgentID, HeaderAdministrator,
			} {
				for _, value := range proxyRequest.In.Header.Values(name) {
					headers.Add(name, value)
				}
			}
			proxyRequest.Out.Header = headers
			proxyRequest.SetXForwarded()
		},
		ModifyResponse: func(upstream *http.Response) error {
			upstream.Header.Del("Set-Cookie")
			if upstream.Request == nil || !strings.HasPrefix(upstream.Request.URL.Path, "/workspace/assets/") {
				upstream.Header.Set("Cache-Control", "no-store")
			}
			if strings.HasPrefix(upstream.Header.Get("Content-Type"), "text/event-stream") {
				upstream.Header.Set("X-Accel-Buffering", "no")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "Workspace request exceeds the payload limit")
				return
			}
			h.logger.ErrorContext(r.Context(), "Workspace Bridge proxy failed", "error_class", "upstream_unavailable")
			writeError(w, http.StatusServiceUnavailable, "workspace_unavailable", "Agent workspace is unavailable")
		},
	}
	if proxy.Transport == nil {
		proxy.Transport = http.DefaultTransport
	}
	return proxy
}
