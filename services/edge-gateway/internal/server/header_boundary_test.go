package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type headerBoundaryContract struct {
	Headers  []struct{ Name string }
	Profiles map[string][]string
	Routes   map[string]struct {
		Profile               string
		CallerContext         string `json:"caller_context"`
		Hints                 []string
		AgentID               string `json:"agent_id"`
		ValidatedPrecondition string `json:"validated_precondition"`
	}
}

func readHeaderBoundaryContract(t *testing.T) headerBoundaryContract {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/edge-gateway/request-headers.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract headerBoundaryContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func boundaryHeaderValues(headers http.Header, name string) []string {
	var result []string
	for key, values := range headers {
		if strings.EqualFold(key, name) {
			result = append(result, values...)
		}
	}
	return result
}

func TestEveryRegisteredBrowserHeaderIsBoundedAtEveryHTTPProxyFamily(t *testing.T) {
	contract := readHeaderBoundaryContract(t)
	standard := map[string]string{
		"Accept": "application/json", "Accept-Encoding": "gzip", "Cache-Control": "no-cache",
		"If-Match": `"revision-1"`, "If-None-Match": `"revision-0"`,
		"If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT", "If-Unmodified-Since": "Thu, 02 Jan 2025 00:00:00 GMT",
		"If-Range": `"revision-1"`, "Range": "bytes=0-15", "Content-Type": "application/json",
		"Idempotency-Key": "receipt-1", "Last-Event-ID": "event-1", "Authorization": "Bearer scim-token",
		"Acp-Connection-Id": "connection-1", "Acp-Session-Id": "session-1",
		"Origin": "http://example.com", "Baggage": "private=value", "X-Unlisted-Browser-Header": "private",
	}
	covered := map[string]bool{}
	for _, route := range []struct{ family, method, path string }{
		{"console-application", "GET", "/"},
		{"console-application", "HEAD", "/assets/app.js"},
		{"admin-api", "GET", "/api/admin/agents"},
		{"admin-api", "POST", "/api/admin/agents"},
		{"admin-api", "GET", "/api/admin/agent-skill-preparations/by-idempotency-key"},
		{"admin-watch", "GET", "/api/admin/agents/agent-1/events/watch"},
		{"admin-network-policy", "PUT", "/api/admin/agents/agent-1/network-policy"},
		{"workspace-document", "GET", "/workspace/"},
		{"workspace-document", "HEAD", "/workspace/agent-1/sessions/session-1"},
		{"workspace-assets", "GET", "/workspace/assets/app.js"},
		{"workspace-assets", "HEAD", "/workspace/assets/app.css"},
		{"workspace-api", "GET", "/api/app/workspace/v1/bootstrap"},
		{"workspace-api", "GET", "/api/app/workspace/v1/agents/agent-1/configuration"},
		{"workspace-api", "POST", "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts"},
		{"workspace-events", "GET", "/api/app/workspace/v1/agents/agent-1/events"},
		{"acp-http", "GET", "/api/app/agents/agent-1/acp"},
		{"acp-http", "POST", "/api/app/agents/agent-1/acp"},
		{"acp-http", "DELETE", "/api/app/agents/agent-1/acp"},
		{"acp-http", "GET", "/api/app/agents/agent-1/v1/acp"},
		{"acp-http", "POST", "/api/app/agents/agent-1/v1/acp"},
		{"acp-http", "DELETE", "/api/app/agents/agent-1/v1/acp"},
		{"scim", "GET", "/scim/v2/Users"},
		{"scim", "POST", "/scim/v2/Users"},
		{"scim", "PUT", "/scim/v2/Users/user-1"},
		{"scim", "PATCH", "/scim/v2/Users/user-1"},
		{"scim", "DELETE", "/scim/v2/Users/user-1"},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			policy, ok := contract.Routes[route.family]
			if !ok {
				t.Fatal("route family missing from contract")
			}
			covered[route.family] = true
			principal := ordinaryPrincipal()
			if strings.HasPrefix(route.family, "admin-") {
				principal = administratorPrincipal()
			}
			hintValues := map[string]string{
				HeaderUserID: "user-admin", HeaderPrincipalID: "user-admin", HeaderOrganizationID: "org-1",
				HeaderMembershipID: "membership-1", HeaderSystemRole: principal.SystemRole, HeaderOrganizationRole: principal.OrganizationRole,
				HeaderAgentID: "agent-1", HeaderAdministrator: "false",
				HeaderOrganizationSlug: base64.RawURLEncoding.EncodeToString([]byte("engineering")),
				HeaderOrganizationName: base64.RawURLEncoding.EncodeToString([]byte("Engineering")),
			}
			expected := map[string][]string{}
			for _, name := range policy.Hints {
				expected[name] = []string{hintValues[name]}
			}
			if policy.CallerContext == "required" {
				expected["Antnest-Caller-Context"] = []string{"trusted-issuer-context"}
			}
			if policy.AgentID == "route" && route.path != "/api/app/workspace/v1/bootstrap" {
				expected[HeaderAgentID] = []string{"agent-1"}
			}
			if policy.ValidatedPrecondition != "" {
				expected[policy.ValidatedPrecondition] = []string{url.PathEscape(`["org-1","user-admin"]`)}
			}
			calls := 0
			upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				for _, header := range contract.Headers {
					if values := boundaryHeaderValues(request.Header, header.Name); !reflect.DeepEqual(values, expected[header.Name]) {
						t.Errorf("%s: got %v, expected %v", header.Name, values, expected[header.Name])
					}
				}
				allowed := map[string]bool{}
				for _, name := range contract.Profiles[policy.Profile] {
					allowed[name] = true
				}
				for name, value := range standard {
					var want []string
					if allowed[name] {
						want = []string{value}
					}
					if got := boundaryHeaderValues(request.Header, name); !reflect.DeepEqual(got, want) {
						t.Errorf("standard field %s: got %v, expected %v", name, got, want)
					}
				}
				for _, name := range []string{"Cookie", "Antnest-Future-Authority", "X-Antnest-Future-Privilege"} {
					if len(boundaryHeaderValues(request.Header, name)) != 0 {
						t.Errorf("unapproved field reached upstream: %s", name)
					}
				}
				response.WriteHeader(http.StatusOK)
			})
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: principal}, upstream, time.Now())
			request := newBrowserRequest(route.method, route.path, strings.NewReader(`{}`))
			addSessionCookies(request, "session-token", testCSRFToken)
			for _, header := range contract.Headers {
				request.Header[http.CanonicalHeaderKey(header.Name)] = []string{"forged", "duplicate"}
			}
			for name, value := range standard {
				request.Header.Set(name, value)
			}
			request.Header.Set("X-Antnest-CSRF-Token", testCSRFToken)
			if policy.ValidatedPrecondition != "" {
				request.Header.Set(policy.ValidatedPrecondition, url.PathEscape(` [ "org-1", "user-admin" ] `))
			}
			request.Header["aNtNeSt-Future-Authority"] = []string{"forged", "duplicate"}
			request.Header["x-aNtNeSt-Future-Privilege"] = []string{"true", "duplicate"}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusOK || calls != 1 {
				t.Fatalf("status=%d calls=%d", response.Code, calls)
			}
		})
	}
	for family := range contract.Routes {
		if !covered[family] {
			t.Errorf("unexercised contract route family: %s", family)
		}
	}
}

func TestProxyAllowlistsDoNotRestoreConnectionNominatedBrowserFields(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/"},
		{http.MethodPost, "/api/admin/agents"},
		{http.MethodPut, "/api/admin/agents/agent-1/network-policy"},
		{http.MethodPost, "/scim/v2/Users"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts"},
		{http.MethodPost, "/api/app/agents/agent-1/v1/acp"},
	} {
		t.Run(route.path, func(t *testing.T) {
			calls := 0
			upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				for _, name := range []string{"Accept", "Content-Type", "Idempotency-Key", "Authorization", "Acp-Connection-Id", "Connection"} {
					if len(boundaryHeaderValues(request.Header, name)) != 0 {
						t.Errorf("Connection-nominated browser field restored: %s", name)
					}
				}
				authenticated := strings.HasPrefix(route.path, "/api/")
				if authenticated {
					if values := boundaryHeaderValues(request.Header, "Antnest-Caller-Context"); len(values) != 1 || values[0] != "trusted-issuer-context" {
						t.Error("server-issued caller context was not injected exactly once")
					}
					principalHeader := HeaderUserID
					if strings.HasPrefix(route.path, "/api/app/agents/") {
						principalHeader = HeaderPrincipalID
					}
					if values := boundaryHeaderValues(request.Header, principalHeader); len(values) != 1 || values[0] != "user-admin" {
						t.Error("server-owned principal was not injected exactly once")
					}
				}
				if strings.HasSuffix(route.path, "/network-policy") {
					if values := boundaryHeaderValues(request.Header, principalPreconditionHeader); len(values) != 1 || values[0] != url.PathEscape(`["org-1","user-admin"]`) {
						t.Error("validated canonical precondition was not injected exactly once")
					}
				}
				for _, name := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
					if values := boundaryHeaderValues(request.Header, name); len(values) != 1 || values[0] == "forged" {
						t.Errorf("server forwarding metadata missing or forged: %s", name)
					}
				}
				response.WriteHeader(http.StatusOK)
			})
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, upstream, time.Now())
			request := newBrowserRequest(route.method, route.path, strings.NewReader(`{}`))
			addSessionCookies(request, "session-token", testCSRFToken)
			request.Header.Set("X-Antnest-CSRF-Token", testCSRFToken)
			request.Header.Set(principalPreconditionHeader, url.PathEscape(` [ "org-1", "user-admin" ] `))
			request.Header.Set("Connection", "Accept, Content-Type, Idempotency-Key, Authorization, Acp-Connection-Id, Antnest-Caller-Context, X-Antnest-User-ID, X-Antnest-Principal-ID, X-Antnest-Expected-Principal, X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto")
			for _, name := range []string{"Accept", "Content-Type", "Idempotency-Key", "Authorization", "Acp-Connection-Id", "Antnest-Caller-Context", HeaderUserID, HeaderPrincipalID, "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
				request.Header.Set(name, "forged")
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusOK || calls != 1 {
				t.Fatalf("test must reach upstream exactly once: status=%d calls=%d", response.Code, calls)
			}
		})
	}
}

func TestHTTPProxiesDiscardBrowserTrailersWithoutChangingBody(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/"},
		{http.MethodPost, "/api/admin/agents"},
		{http.MethodPost, "/scim/v2/Users"},
		{http.MethodPost, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts"},
		{http.MethodPost, "/api/app/agents/agent-1/v1/acp"},
	} {
		t.Run(route.path, func(t *testing.T) {
			calls := 0
			upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				if len(request.Trailer) != 0 {
					t.Error("browser trailer declarations reached outbound transport")
				}
				body, err := io.ReadAll(request.Body)
				if err != nil || string(body) != `{"opaque":"payload"}` {
					t.Errorf("body changed: %q, %v", body, err)
				}
				if len(request.Trailer) != 0 {
					t.Error("browser trailer values reached outbound transport after EOF")
				}
				response.WriteHeader(http.StatusOK)
			})
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, upstream, time.Now())
			request := newBrowserRequest(route.method, route.path, strings.NewReader(`{"opaque":"payload"}`))
			addSessionCookies(request, "session-token", testCSRFToken)
			request.Header.Set("X-Antnest-CSRF-Token", testCSRFToken)
			request.Header.Set("Trailer", "Antnest-Future-Authority, X-Antnest-Administrator, X-Unlisted-Trailer")
			request.ContentLength = -1
			request.TransferEncoding = []string{"chunked"}
			request.Trailer = http.Header{
				"Antnest-Future-Authority": {"forged"},
				"X-Antnest-Administrator":  {"true"},
				"X-Unlisted-Trailer":       {"unapproved"},
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusOK || calls != 1 {
				t.Fatalf("test must reach upstream exactly once: status=%d calls=%d", response.Code, calls)
			}
		})
	}
}

func TestReservedHeaderNamespacesAreRemovedBeforeRouting(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://localhost/", nil)
	request.Header = http.Header{
		"Antnest-Future-Authority":     {"first", "second"},
		"aNtNeSt-Another-Authority":    {"third"},
		"x-aNtNeSt-Future-Privilege":   {"administrator"},
		"X-Antnest-CSRF-Token":         {"private-csrf"},
		"x-antnest-expected-principal": {"private-precondition"},
		"Antnested-Unrelated":          {"ordinary-header"},
		"Content-Type":                 {"application/json"},
		"Origin":                       {"http://localhost"},
	}
	stripBrowserCredentials(request)
	for name := range request.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-antnest-") || strings.HasPrefix(lower, "antnest-") {
			t.Errorf("reserved browser header retained: %s", name)
		}
	}
	if request.Header.Get("Antnested-Unrelated") != "ordinary-header" ||
		request.Header.Get("Content-Type") != "application/json" ||
		request.Header.Get("Origin") != "http://localhost" {
		t.Fatal("namespace sanitizer removed unrelated or local admission headers")
	}
	csrf, _ := request.Context().Value(csrfKey{}).([]string)
	precondition, _ := request.Context().Value(principalPreconditionKey{}).([]string)
	if len(csrf) != 1 || csrf[0] != "private-csrf" ||
		len(precondition) != 1 || precondition[0] != "private-precondition" {
		t.Fatal("local browser credentials were not retained privately")
	}
}

func TestGenericProxiesRequireExplicitForwardedHeaders(t *testing.T) {
	for _, path := range []string{"/", "/api/admin/agents", "/scim/v2/Users"} {
		t.Run(path, func(t *testing.T) {
			calls := 0
			upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				calls++
				for _, name := range []string{
					"Antnest-Future-Authority", "X-Antnest-Future-Privilege", "X-Unlisted-Browser-Header",
					"Cookie", "X-Antnest-CSRF-Token", "X-Antnest-Expected-Principal",
				} {
					if len(boundaryHeaderValues(request.Header, name)) != 0 {
						t.Errorf("unapproved browser header reached %s upstream: %s", path, name)
					}
				}
				if request.Header.Get("Accept") != "application/json" {
					t.Error("declared Accept header was lost")
				}
				if path == "/scim/v2/Users" {
					if request.Header.Get("Authorization") != "Bearer scim-credential" {
						t.Error("SCIM bearer credential was lost")
					}
				} else if request.Header.Get("Authorization") != "" {
					t.Error("browser Authorization reached a non-SCIM upstream")
				}
				if path == "/api/admin/agents" && request.Header.Get("Antnest-Caller-Context") != "trusted-issuer-context" {
					t.Error("verified caller context was lost")
				}
				response.WriteHeader(http.StatusOK)
			})
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: administratorPrincipal()}, upstream, time.Now())
			request := newBrowserRequest(http.MethodGet, path, nil)
			addSessionCookies(request, "session-token", testCSRFToken)
			request.Header.Set("Accept", "application/json")
			request.Header.Set("Authorization", "Bearer scim-credential")
			request.Header.Set("Antnest-Future-Authority", "forged")
			request.Header.Set("X-Antnest-Future-Privilege", "administrator")
			request.Header.Set("X-Unlisted-Browser-Header", "private-browser-value")
			request.Header.Set("X-Antnest-CSRF-Token", testCSRFToken)
			request.Header.Set("X-Antnest-Expected-Principal", "unrelated-route-value")
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != http.StatusOK || calls != 1 {
				t.Fatalf("test must reach upstream exactly once: status=%d calls=%d", response.Code, calls)
			}
		})
	}
}
