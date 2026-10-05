package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

const organizationSlugHeader = "X-Antnest-Organization-Slug"
const organizationNameHeader = "X-Antnest-Organization-Name"

func displayPrincipal(t *testing.T, name string, administrator bool) identity.Principal {
	t.Helper()
	value := map[string]any{
		"user_id": "user-1", "organization_id": "org-1", "membership_id": "member-1",
		"organization_slug": "engineering", "organization_name": name,
		"system_role": "user", "organization_role": "member", "active": true,
	}
	if administrator {
		value["organization_role"] = "admin"
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var principal identity.Principal
	if err := json.Unmarshal(data, &principal); err != nil {
		t.Fatal(err)
	}
	principal.CallerContext = "trusted-issuer-context"
	return principal
}

func compileOrganizationSchema(t *testing.T, path, definition string) *jsonschema.Schema {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/" + path)
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if path == "agent-ui/workspace-api.schema.json" {
		// The rest of the Workspace schema contains ECMAScript lookaheads that
		// Go's regexp engine cannot compile. Import these exact central definitions;
		// the Node contract gate validates the entire Workspace document with Ajv.
		all := document.(map[string]any)["$defs"].(map[string]any)
		document = map[string]any{
			"$schema": "https://json-schema.org/draft/2020-12/schema",
			"$defs":   map[string]any{"id": all["id"], "organizationDisplay": all["organizationDisplay"], "verifiedWorkspacePrincipal": all["verifiedWorkspacePrincipal"]},
		}
	}
	const id = "https://antnest.test/organization-contract.json"
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(id, document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(id + "#/$defs/" + definition)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func TestOrganizationSessionHandlersMatchCentralSchemas(t *testing.T) {
	for _, administrator := range []bool{false, true} {
		name := "研发 · Équipe 🚀"
		principal := displayPrincipal(t, name, administrator)
		stub := &identityServiceStub{
			loginResult:      identity.LoginResult{Principal: principal, TokenID: "private-token-id", AccessToken: "ant_api_private", ExpiresAt: time.Now().Add(time.Hour)},
			resolvePrincipal: principal,
		}
		handler := newTestHandler(t, stub, http.NotFoundHandler(), time.Now())
		for _, route := range []struct{ method, path, body, definition string }{
			{http.MethodPost, "/api/session/login", `{"organization_slug":"engineering","email":"member@example.com","password":"synthetic"}`, "login"},
			{http.MethodGet, "/api/session", "", "session"},
		} {
			request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
			request.Header.Set("Content-Type", "application/json")
			addSessionCookies(request, "ant_api_private", "csrf")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("%s status %d", route.path, response.Code)
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := compileOrganizationSchema(t, "edge-gateway/session-response.schema.json", route.definition).Validate(value); err != nil {
				t.Fatalf("real Gateway %s output violates its central schema: %v", route.path, err)
			}
			actual := value.(map[string]any)["principal"].(map[string]any)
			if actual["organization_name"] != name || actual["organization_slug"] != "engineering" {
				t.Fatal("browser response lost verified organization labels")
			}
			if strings.Contains(response.Body.String(), "ant_api_private") || strings.Contains(response.Body.String(), "private-token-id") {
				t.Fatal("browser response leaked an access credential")
			}
		}
	}
}

func TestOrganizationProjectionIsVerifiedFreshAndSchemaValid(t *testing.T) {
	schema := compileOrganizationSchema(t, "agent-ui/workspace-api.schema.json", "verifiedWorkspacePrincipal")
	for _, administrator := range []bool{false, true} {
		stub := &identityServiceStub{resolvePrincipal: displayPrincipal(t, "研发 · Équipe 🚀", administrator)}
		var forwarded http.Header
		gateway := newTestHandler(t, stub, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			forwarded = r.Header.Clone()
			w.WriteHeader(200)
		}), time.Now())
		for _, name := range []string{"研发 · Équipe 🚀", "Renamed <workspace> & 团队"} {
			stub.resolvePrincipal = displayPrincipal(t, name, administrator)
			for _, path := range []string{"/api/app/workspace/v1/bootstrap", "/workspace/"} {
				request := httptest.NewRequest(http.MethodGet, path, nil)
				addSessionCookies(request, "ant_api_private", "csrf")
				request.Header.Add(organizationSlugHeader, "forged")
				request.Header.Add(organizationSlugHeader, "other")
				request.Header.Set(organizationNameHeader, "forged-name")
				request.Header.Set(HeaderOrganizationID, "forged-org")
				request.Header.Set(HeaderAdministrator, "true")
				response := httptest.NewRecorder()
				gateway.ServeHTTP(response, request)
				if response.Code != 200 {
					t.Fatalf("%s: HTTP %d", path, response.Code)
				}
				for field, expected := range map[string]string{organizationSlugHeader: "engineering", organizationNameHeader: name} {
					values := forwarded.Values(field)
					if len(values) != 1 || values[0] != base64.RawURLEncoding.EncodeToString([]byte(expected)) {
						t.Fatalf("%s did not carry one encoded verified value", field)
					}
				}
				projection := map[string]any{"userId": forwarded.Get(HeaderPrincipalID), "organizationId": forwarded.Get(HeaderOrganizationID), "administrator": forwarded.Get(HeaderAdministrator) == "true"}
				for field, key := range map[string]string{organizationSlugHeader: "organizationSlug", organizationNameHeader: "organizationName"} {
					decoded, err := base64.RawURLEncoding.Strict().DecodeString(forwarded.Get(field))
					if err != nil {
						t.Fatal(err)
					}
					projection[key] = string(decoded)
				}
				if err := schema.Validate(projection); err != nil {
					t.Fatalf("Gateway projection violates agreed Node principal schema: %v", err)
				}
				if projection["organizationId"] != "org-1" || projection["userId"] != "user-1" || projection["administrator"] != administrator || forwarded.Get("Cookie") != "" || forwarded.Get("Authorization") != "" {
					t.Fatal("display rename or forged headers changed scope/authority")
				}
			}
		}
		if end := gateway.(*handler).checkRelaySession(context.Background(), "token", displayPrincipal(t, "Old name", administrator)); end != nil {
			t.Fatal("display-only rename invalidated existing authorization scope")
		}
	}
}

func TestOrganizationProjectionDoesNotReachAnonymousAssetsOrConsole(t *testing.T) {
	var forwarded http.Header
	handler := newTestHandler(t, &identityServiceStub{resolvePrincipal: displayPrincipal(t, "Engineering", true)}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded = r.Header.Clone()
		w.WriteHeader(200)
	}), time.Now())
	for _, path := range []string{"/workspace/assets/app.js", "/", "/api/admin/directory"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		addSessionCookies(request, "token", "csrf")
		request.Header.Set(organizationSlugHeader, "forged")
		request.Header.Set(organizationNameHeader, "forged")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 200 || forwarded.Get(organizationSlugHeader) != "" || forwarded.Get(organizationNameHeader) != "" {
			t.Fatalf("%s leaked untrusted display headers", path)
		}
	}
}

func TestOrganizationMalformedIdentityNeverAdmitsWorkspace(t *testing.T) {
	for _, field := range []string{"organization_slug", "organization_name"} {
		for _, invalid := range []string{"missing", "unicode_whitespace"} {
			t.Run(field+"/"+invalid, func(t *testing.T) {
				principal := displayPrincipal(t, "Engineering", false)
				data, err := json.Marshal(principal)
				if err != nil {
					t.Fatal(err)
				}
				var value map[string]any
				if err := json.Unmarshal(data, &value); err != nil {
					t.Fatal(err)
				}
				if invalid == "missing" {
					delete(value, field)
				} else {
					value[field] = "\uFEFF\u00A0\u2028"
				}
				body, err := json.Marshal(map[string]any{"principal": value, "access_token": "ant_api_private", "expires_at": "2026-10-03T00:00:00Z"})
				if err != nil {
					t.Fatal(err)
				}
				client, err := identity.NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
				})})
				if err != nil {
					t.Fatal(err)
				}
				contacted := 0
				gateway := newTestHandler(t, client, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { contacted++ }), time.Now())
				for _, route := range []struct{ method, path, body string }{
					{http.MethodPost, "/api/session/login", `{"organization_slug":"engineering","email":"member@example.com","password":"synthetic"}`},
					{http.MethodGet, "/api/session", ""},
					{http.MethodGet, "/api/app/workspace/v1/bootstrap", ""},
					{http.MethodGet, "/workspace/", ""},
				} {
					request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
					request.Header.Set("Content-Type", "application/json")
					addSessionCookies(request, "ant_api_private", "csrf")
					response := httptest.NewRecorder()
					gateway.ServeHTTP(response, request)
					if response.Code != 503 || contacted != 0 || len(response.Result().Cookies()) != 0 {
						t.Fatalf("%s admitted malformed Identity or destroyed a browser session", route.path)
					}
				}
			})
		}
	}
}
