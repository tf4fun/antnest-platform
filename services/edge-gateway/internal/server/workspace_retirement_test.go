package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestRetiredWorkspaceRoutesRejectBeforeAuthenticationAndForwarding(t *testing.T) {
	for _, path := range []string{
		"/api/app/bootstrap",
		"/api/app/agents/agent-1/state",
		"/api/app/agents/agent-1/state/watch",
		"/api/app/agents/agent-1/acp",
		"/api/app/agents/agent-1/v1/acp",
		"/api/app/agents/agent-1/v2/acp",
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodDelete} {
			for _, authenticated := range []bool{false, true} {
				for _, upgrade := range []bool{false, true} {
					if upgrade && method != http.MethodGet {
						continue
					}
					name := method + " " + path + "/anonymous"
					if authenticated {
						name = method + " " + path + "/session"
					}
					if upgrade {
						name += "/upgrade"
					}
					t.Run(name, func(t *testing.T) {
						h, identities, upstreamCalls := newOriginTestHandler(t, Config{})
						request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
						request.Header.Set("Origin", admissionPublicOrigin)
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set("Authorization", "Bearer browser-supplied")
						request.Header.Set(HeaderPrincipalID, "browser-supplied")
						if authenticated {
							addSessionCookies(request, "token-1", testCSRFToken)
							request.Header.Set(session.CSRFHeaderName, testCSRFToken)
						}
						if upgrade {
							request.Header.Set("Connection", "Upgrade")
							request.Header.Set("Upgrade", "websocket")
							request.Header.Set("Sec-WebSocket-Version", "13")
							request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
						}
						response := httptest.NewRecorder()
						h.ServeHTTP(response, request)
						if response.Code != http.StatusNotFound {
							t.Errorf("retired route status=%d body=%s", response.Code, response.Body.String())
						}
						if identities.called() || *upstreamCalls != 0 {
							t.Errorf("retired route reached Identity=%t or HTTP upstream=%d", identities.called(), *upstreamCalls)
						}
						if method != http.MethodHead {
							var body struct {
								Code string `json:"code"`
							}
							if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Code != "not_found" {
								t.Errorf("retired route body=%s error=%v", response.Body.String(), err)
							}
						}
						if len(response.Result().Cookies()) != 0 || response.Header().Get("Upgrade") != "" || response.Header().Get("Cache-Control") != "no-store" {
							t.Errorf("retired route changed browser state or upgraded: %v", response.Header())
						}
						assertDefaultSecurityHeaders(t, response.Header())
					})
				}
			}
		}
	}
}

func TestRetiredWorkspaceRoutesKeepOuterOriginAdmission(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		h, identities, upstreamCalls := newOriginTestHandler(t, Config{})
		request := httptest.NewRequest(method, "/api/app/agents/agent-1/v1/acp", nil)
		request.Header.Set("Origin", "https://foreign.example")
		addSessionCookies(request, "token-1", testCSRFToken)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		assertOriginRejection(t, response)
		if identities.called() || *upstreamCalls != 0 || len(response.Result().Cookies()) != 0 {
			t.Fatalf("rejected retired route reached downstream or wrote cookies")
		}
	}
}
