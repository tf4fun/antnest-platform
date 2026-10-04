package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestRPCAdmissionPoliciesMatchTheOwningCallerCatalog(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/identity/callers.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Routes map[string]struct {
			Callers        []string          `json:"callers"`
			Authentication string            `json:"authentication"`
			Context        map[string]string `json:"caller_context"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	checked := make(map[string]bool)
	for route, policy := range catalog.Routes {
		if policy.Authentication != "workload" {
			continue
		}
		_, path, ok := strings.Cut(route, " ")
		if !ok || (!strings.HasPrefix(path, "/rpc/identity/") && path != "/protocol/oidc/callback") {
			continue
		}
		if !slices.Equal(routeCallers[path], policy.Callers) {
			t.Errorf("%s policy drift", route)
		}
		for caller, context := range policy.Context {
			if caller == "admin-console" && path != "/rpc/identity/jwks" && context != "required" {
				t.Errorf("%s omitted CCT requirement", route)
			}
		}
		checked[path] = true
	}
	for path := range routeCallers {
		if !checked[path] {
			t.Errorf("implementation policy has no contract: %s", path)
		}
	}
}

// Enumerate the contract, rather than three sample handlers, so adding an
// administrative RPC cannot silently escape the credential boundary.
func TestEveryAdministrativeRPCRejectsBodyActorWithoutCallerContext(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Methods map[string]struct {
			Path    string `json:"path"`
			Request struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"request"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for name, method := range contract.Methods {
		if _, administrative := method.Request.Properties["actor_principal_id"]; !administrative {
			continue
		}
		checked++
		t.Run(name, func(t *testing.T) {
			services := &rpcServicesStub{}
			deps, _ := authenticationDependencies(t, Dependencies{
				Directory: services, LocalAuth: services, OIDC: services, SCIM: services,
			})
			handler, err := NewHandler(deps)
			if err != nil {
				t.Fatal(err)
			}
			body := administrativeBody(method.Request.Properties)
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/rpc/identity"+method.Path, strings.NewReader(string(encoded)))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Antnest-Service-Authorization", "Bearer AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "caller_context_required") {
				t.Fatalf("body-selected administrator reached %s: status=%d body=%s", name, response.Code, response.Body.String())
			}
		})
	}
	if checked == 0 {
		t.Fatal("contract contains no administrative RPCs")
	}
}

func TestAdministrativeAdmissionRejectsForgedOrMisboundCredentials(t *testing.T) {
	for _, test := range []struct {
		name, workload, cct, body string
		status                    int
		code                      string
	}{
		{"missing workload", "", "valid", `{"actor_principal_id":"admin","organization_id":"org-1"}`, 401, "service_unauthenticated"},
		{"wrong workload", gatewayTestToken, "valid", `{"actor_principal_id":"admin","organization_id":"org-1"}`, 403, "caller_not_allowed"},
		{"invalid CCT", consoleTestToken, "invalid", `{"actor_principal_id":"admin","organization_id":"org-1"}`, 401, "caller_context_invalid"},
		{"body spoof", consoleTestToken, "valid", `{"actor_principal_id":"victim","organization_id":"org-1"}`, 403, "actor_mismatch"},
		{"organization spoof", consoleTestToken, "valid", `{"actor_principal_id":"admin","organization_id":"victim"}`, 401, "caller_context_invalid"},
		{"revoked session", consoleTestToken, "revoked", `{"actor_principal_id":"admin","organization_id":"org-1"}`, 401, "caller_context_invalid"},
		{"duplicate CCT", consoleTestToken, "duplicate", `{"actor_principal_id":"admin","organization_id":"org-1"}`, 401, "caller_context_invalid"},
		{"duplicate JSON", consoleTestToken, "valid", `{"actor_principal_id":"admin","actor_principal_id":"admin","organization_id":"org-1"}`, 400, "bad_request"},
		{"case-folded actor spoof", consoleTestToken, "valid", `{"actor_principal_id":"admin","ACTOR_PRINCIPAL_ID":"victim","organization_id":"org-1"}`, 400, "bad_request"},
	} {
		t.Run(test.name, func(t *testing.T) {
			services := &rpcServicesStub{}
			deps, sessions := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
			_, token, err := deps.CallerContext.Issue(t.Context(), "access-token", "console", "")
			if err != nil {
				t.Fatal(err)
			}
			if test.cct == "invalid" {
				token = "forged"
			}
			if test.cct == "revoked" {
				sessions.err = domain.ErrNotFound
			}
			handler, err := NewHandler(deps)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest("POST", "/rpc/identity/list-directory", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			if test.workload != "" {
				request.Header.Set(serviceauth.Header, "Bearer "+test.workload)
			}
			request.Header.Set(callercontext.Header, token)
			if test.cct == "duplicate" {
				request.Header.Add(callercontext.Header, token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestJWKSRequiresWorkloadButNoCallerContext(t *testing.T) {
	services := &rpcServicesStub{}
	deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", gatewayTestToken, consoleTestToken, controllerTestToken} {
		request := httptest.NewRequest("GET", "/rpc/identity/jwks", nil)
		if token != "" {
			request.Header.Set(serviceauth.Header, "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if token == "" {
			if response.Code != 401 {
				t.Fatalf("anonymous JWKS status=%d", response.Code)
			}
			continue
		}
		if response.Code != 200 || strings.Contains(response.Body.String(), `"d"`) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestRPCMediaTypeAndBoundedBodyAreCheckedBeforeEffects(t *testing.T) {
	valid := `{"request_id":"login","organization_slug":"organization","email":"member@example.com","password":"password"}`
	for _, test := range []struct {
		name   string
		types  []string
		body   string
		status int
	}{
		{"missing content type", nil, valid, 415},
		{"form content type", []string{"application/x-www-form-urlencoded"}, valid, 415},
		{"duplicate content type", []string{"application/json", "application/json"}, valid, 415},
		{"extra charset", []string{"application/json; charset=iso-8859-1"}, valid, 415},
		{"oversized trailing whitespace", []string{"application/json"}, valid + strings.Repeat(" ", maxRequestBytes), 400},
		{"multiple documents", []string{"application/json"}, valid + " {}", 400},
		{"invalid UTF-8", []string{"application/json"}, valid + string([]byte{0xff}), 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			services := &rpcServicesStub{}
			deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
			handler, err := NewHandler(deps)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest("POST", ContractRoutes["local_login"], strings.NewReader(test.body))
			request.Header.Set(serviceauth.Header, "Bearer "+gatewayTestToken)
			for _, value := range test.types {
				request.Header.Add("Content-Type", value)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status || services.loginCalls != 0 {
				t.Fatalf("status=%d calls=%d", response.Code, services.loginCalls)
			}
		})
	}
}

func administrativeBody(properties map[string]json.RawMessage) map[string]any {
	body := make(map[string]any, len(properties))
	for field := range properties {
		switch field {
		case "actor_principal_id":
			body[field] = "admin"
		case "organization_id":
			body[field] = "org-1"
		case "active", "enabled":
			body[field] = true
		case "role":
			body[field] = "member"
		case "scopes":
			body[field] = []string{"scim:read"}
		case "email", "owner_email":
			body[field] = "member@example.com"
		case "issuer":
			body[field] = "https://issuer.example.com"
		default:
			body[field] = "test-value"
		}
	}
	return body
}
