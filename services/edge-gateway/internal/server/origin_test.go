package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

const admissionPublicOrigin = "https://antnest.example"

type originIdentity struct {
	identityServiceStub
	resolveCalls int
}

func (stub *originIdentity) Resolve(ctx context.Context, token string) (identity.Principal, error) {
	stub.resolveCalls++
	return stub.identityServiceStub.Resolve(ctx, token)
}

func (stub *originIdentity) called() bool {
	return stub.resolveCalls != 0 || stub.loginCalls != 0 || stub.startOIDCCalls != 0 ||
		stub.loginMethodsOrganization != "" || stub.revokedAccessToken != ""
}

func newOriginTestHandler(t *testing.T, cfg Config) (http.Handler, *originIdentity, *int) {
	t.Helper()
	now := time.Now()
	identities := &originIdentity{identityServiceStub: identityServiceStub{
		resolvePrincipal: administratorPrincipal(),
		loginResult: identity.LoginResult{
			Principal: administratorPrincipal(), TokenID: "token-1", AccessToken: "token-1", ExpiresAt: now.Add(time.Hour),
		},
		startOIDCResult: identity.StartOIDCLoginResult{
			AuthorizationURL: "https://login.example/authorize?state=state-1", ExpiresAt: now.Add(time.Minute),
		},
		revokeStatus: identity.RevokeStatusRevoked,
	}}
	calls := new(int)
	cfg.PublicOrigin = admissionPublicOrigin
	h := newTestHandlerWithConfig(t, identities, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		w.WriteHeader(http.StatusAccepted)
	}), now, cfg)
	return h, identities, calls
}

func assertOriginRejection(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid rejection body: %v: %s", err, response.Body.String())
	}
	if response.Code != http.StatusForbidden || body.Code != "forbidden" || body.Message != "Request origin is not allowed" {
		t.Fatalf("origin rejection: status=%d body=%s", response.Code, response.Body.String())
	}
	assertDefaultSecurityHeaders(t, response.Header())
	if response.Header().Get("Strict-Transport-Security") != "max-age=31536000" {
		t.Fatal("origin rejection lost HSTS")
	}
}

func TestOriginAdmissionOnEveryMutationRoute(t *testing.T) {
	for _, route := range []struct {
		name, method, path, body string
		status                   int
		proxy                    bool
	}{
		{"workspace", "POST", "/api/app/workspace/v1/agents/agent-1/sessions", `{}`, 202, true},
		{"acp-post", "POST", "/api/app/agents/agent-1/v1/acp", `{}`, 202, true},
		{"acp-delete", "DELETE", "/api/app/agents/agent-1/v1/acp", "", 202, true},
		{"acp-alias-post", "POST", "/api/app/agents/agent-1/acp", `{}`, 202, true},
		{"acp-alias-delete", "DELETE", "/api/app/agents/agent-1/acp", "", 202, true},
		{"admin-post", "POST", "/api/admin/agents", `{}`, 202, true},
		{"admin-put", "PUT", "/api/admin/agents/agent-1", `{}`, 202, true},
		{"admin-patch", "PATCH", "/api/admin/agents/agent-1", `{}`, 202, true},
		{"admin-delete", "DELETE", "/api/admin/agents/agent-1", "", 202, true},
		{"login", "POST", "/api/session/login", `{"organization_slug":"org","email":"user@example.test","password":"secret"}`, 200, false},
		{"login-methods", "POST", "/api/session/login-methods", `{"organization_slug":"org"}`, 200, false},
		{"oidc-start", "POST", "/api/session/oidc/start", `{"organization_slug":"org","provider_name":"oidc"}`, 200, false},
		{"logout", "DELETE", "/api/session", "", 204, false},
	} {
		t.Run(route.name, func(t *testing.T) {
			for _, evidence := range []struct {
				name             string
				origin, metadata []string
				admit            bool
			}{
				{"matching", []string{admissionPublicOrigin}, nil, true},
				{"matching-same-origin", []string{admissionPublicOrigin}, []string{"same-origin"}, true},
				{"matching-none", []string{admissionPublicOrigin}, []string{"none"}, true},
				{"foreign", []string{"https://foreign.example"}, nil, false},
				{"null", []string{"null"}, []string{"same-origin"}, false},
				{"empty-origin", []string{""}, []string{"same-origin"}, false},
				{"duplicate-origin", []string{admissionPublicOrigin, admissionPublicOrigin}, nil, false},
				{"joined-origin", []string{admissionPublicOrigin + ", " + admissionPublicOrigin}, nil, false},
				{"metadata-only", nil, []string{"same-origin"}, true},
				{"cross-site", nil, []string{"cross-site"}, false},
				{"same-site", nil, []string{"same-site"}, false},
				{"contradictory-cross-site", []string{admissionPublicOrigin}, []string{"cross-site"}, false},
				{"contradictory-same-site", []string{admissionPublicOrigin}, []string{"same-site"}, false},
				{"none", nil, []string{"none"}, false},
				{"empty-metadata", []string{admissionPublicOrigin}, []string{""}, false},
				{"unknown-metadata", nil, []string{"unrecognized"}, false},
				{"matching-unknown-metadata", []string{admissionPublicOrigin}, []string{"unrecognized"}, false},
				{"duplicate-metadata", []string{admissionPublicOrigin}, []string{"same-origin", "same-origin"}, false},
				{"joined-metadata", nil, []string{"same-origin, cross-site"}, false},
				{"matching-joined-metadata", []string{admissionPublicOrigin}, []string{"same-origin, cross-site"}, false},
				{"both-absent", nil, nil, false},
			} {
				for _, allow := range []bool{false, true} {
					t.Run(evidence.name+"/originless="+strconv.FormatBool(allow), func(t *testing.T) {
						h, identities, calls := newOriginTestHandler(t, Config{AllowOriginlessMutations: allow})
						request := httptest.NewRequest(route.method, "http://private-gateway.internal"+route.path, strings.NewReader(route.body))
						if evidence.origin != nil {
							request.Header["Origin"] = evidence.origin
						}
						if evidence.metadata != nil {
							request.Header["Sec-Fetch-Site"] = evidence.metadata
						}
						request.Header.Set("Content-Type", "application/json")
						request.Header.Set(session.CSRFHeaderName, testCSRFToken)
						addSessionCookies(request, "token-1", testCSRFToken)
						response := httptest.NewRecorder()
						h.ServeHTTP(response, request)
						admitted := evidence.admit || (allow && evidence.origin == nil && evidence.metadata == nil)
						if !admitted {
							assertOriginRejection(t, response)
							if identities.called() || *calls != 0 {
								t.Fatal("Origin rejected after Identity or upstream call")
							}
							if len(response.Result().Cookies()) != 0 {
								t.Fatal("Origin rejection mutated browser cookies")
							}
							return
						}
						if response.Code != route.status || !identities.called() || (route.proxy && *calls != 1) {
							t.Fatalf("admitted request: status=%d calls=%d identity=%v body=%s", response.Code, *calls, identities.called(), response.Body.String())
						}
					})
				}
			}
		})
	}
}

func TestOriginAdmissionSafeMethods(t *testing.T) {
	for _, route := range []struct {
		method, path string
		status       int
	}{
		{"GET", "/api/admin/agents", 202}, {"HEAD", "/api/admin/agents", 202},
		{"OPTIONS", "/api/admin/agents", 202}, {"GET", "/api/session", 200},
		{"GET", "/api/app/bootstrap", 200},
	} {
		for _, origin := range []string{"", admissionPublicOrigin, "https://foreign.example"} {
			t.Run(route.method+route.path+origin, func(t *testing.T) {
				h, identities, calls := newOriginTestHandler(t, Config{})
				request := httptest.NewRequest(route.method, route.path, nil)
				if origin != "" {
					request.Header.Set("Origin", origin)
				}
				request.Header.Set("Sec-Fetch-Site", "cross-site")
				addSessionCookies(request, "token-1", testCSRFToken)
				response := httptest.NewRecorder()
				h.ServeHTTP(response, request)
				if origin == "https://foreign.example" {
					assertOriginRejection(t, response)
					if identities.called() || *calls != 0 {
						t.Fatal("rejected read reached Identity or upstream")
					}
				} else if response.Code != route.status {
					t.Fatalf("safe request rejected: status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestOriginAdmissionPrecedesRouting(t *testing.T) {
	for _, target := range []string{"/api/unknown", "/api/session/login/unknown", "/api/app/workspace/v1/agents/agent-1/sessions"} {
		for _, origin := range []string{"", admissionPublicOrigin} {
			t.Run(target+origin, func(t *testing.T) {
				h, _, _ := newOriginTestHandler(t, Config{})
				request := httptest.NewRequest("PATCH", target, nil)
				if origin != "" {
					request.Header.Set("Origin", origin)
				}
				response := httptest.NewRecorder()
				h.ServeHTTP(response, request)
				if origin == "" {
					assertOriginRejection(t, response)
				} else if response.Code != 404 && response.Code != 405 {
					t.Fatalf("admitted request did not reach routing: %d %s", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestOriginAdmissionKeepsCSRFIndependent(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/app/workspace/v1/agents/agent-1/sessions"},
		{"POST", "/api/app/agents/agent-1/v1/acp"}, {"DELETE", "/api/app/agents/agent-1/acp"},
		{"POST", "/api/admin/agents"}, {"PUT", "/api/admin/agents/agent-1"},
		{"PATCH", "/api/admin/agents/agent-1"}, {"DELETE", "/api/admin/agents/agent-1"},
		{"DELETE", "/api/session"},
	} {
		for _, csrf := range []string{"", "wrong"} {
			for _, origin := range []string{"", admissionPublicOrigin} {
				t.Run(route.method+route.path+csrf+origin, func(t *testing.T) {
					h, identities, calls := newOriginTestHandler(t, Config{AllowOriginlessMutations: true})
					request := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
					if origin != "" {
						request.Header.Set("Origin", origin)
					}
					request.Header.Set(session.CSRFHeaderName, csrf)
					addSessionCookies(request, "token-1", testCSRFToken)
					response := httptest.NewRecorder()
					h.ServeHTTP(response, request)
					if response.Code != 403 || !strings.Contains(response.Body.String(), `"code":"csrf_failed"`) || *calls != 0 || identities.revokedAccessToken != "" {
						t.Fatalf("CSRF bypass: status=%d calls=%d body=%s", response.Code, *calls, response.Body.String())
					}
				})
			}
		}
	}
}

func TestOriginAdmissionKeepsWebSocketOriginMandatory(t *testing.T) {
	for _, suffix := range []string{"acp", "v1/acp", "v2/acp"} {
		for _, allow := range []bool{false, true} {
			for _, metadata := range []string{"", "same-origin"} {
				t.Run(suffix+"/"+strconv.FormatBool(allow)+"/"+metadata, func(t *testing.T) {
					h, identities, calls := newOriginTestHandler(t, Config{AllowOriginlessMutations: allow})
					request := httptest.NewRequest("GET", "/api/app/agents/agent-1/"+suffix, nil)
					request.Header.Set("Connection", "Upgrade")
					request.Header.Set("Upgrade", "websocket")
					if metadata != "" {
						request.Header.Set("Sec-Fetch-Site", metadata)
					}
					addSessionCookies(request, "token-1", testCSRFToken)
					response := httptest.NewRecorder()
					h.ServeHTTP(response, request)
					if response.Code != 403 || identities.called() || *calls != 0 {
						t.Fatalf("originless WS admitted: status=%d calls=%d identity=%v", response.Code, *calls, identities.called())
					}
				})
			}
		}
	}
}
