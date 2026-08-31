package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
	"soft/antnest-platform/services/identity-service/internal/oidcflow"
	"soft/antnest-platform/services/identity-service/internal/scim"
)

func TestRPCRejectsUnknownFieldsBeforeCallingService(t *testing.T) {
	services := &rpcServicesStub{}
	handler := newRPCHandler(t, services)
	request := httptest.NewRequest(http.MethodPost, ContractRoutes["local_login"], strings.NewReader(`{
		"request_id":"request-1","organization_slug":"engineering","email":"alice@example.com",
		"password":"correct horse battery staple","unknown":true
	}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || services.loginCalls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, services.loginCalls, response.Body.String())
	}
}

func TestRPCMapsDomainErrorsAndOIDCCallbackDisablesCaching(t *testing.T) {
	services := &rpcServicesStub{resolveErr: domain.ErrUnauthenticated}
	handler := newRPCHandler(t, services)
	request := httptest.NewRequest(http.MethodPost, ContractRoutes["resolve_access_token"],
		strings.NewReader(`{"access_token":"invalid"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "unauthenticated") {
		t.Fatalf("resolve status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/protocol/oidc/callback?state=state-1&code=code-1", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("callback status=%d cache=%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
}

func TestRPCMapsInvalidArgumentsToBadRequest(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, domain.InvalidArgument("email is invalid"))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid_argument") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRPCMapsOIDCStateErrorsToDeterministicStatuses(t *testing.T) {
	tests := []struct {
		code   string
		status int
	}{
		{code: "oidc_exchange_claim_invalid", status: http.StatusBadRequest},
		{code: "oidc_session_failed", status: http.StatusBadRequest},
		{code: "oidc_provider_issuer_immutable", status: http.StatusConflict},
		{code: "oidc_exchange_in_progress", status: http.StatusConflict},
		{code: "oidc_session_expired", status: http.StatusGone},
		{code: "oidc_completed_token_unavailable", status: http.StatusGone},
	}
	for _, test := range tests {
		t.Run(test.code, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeError(response, domain.NewError(test.code, "stable message", false))
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
		})
	}
}

func TestRPCPreservesAuditRequestIDsForDirectoryMutations(t *testing.T) {
	services := &rpcServicesStub{}
	handler := newRPCHandler(t, services)
	for _, test := range []struct {
		path string
		body string
	}{
		{
			path: ContractRoutes["create_organization"],
			body: `{"request_id":"organization-request","actor_principal_id":"admin","slug":"engineering","name":"Engineering"}`,
		},
		{
			path: ContractRoutes["create_local_user"],
			body: `{"request_id":"user-request","actor_principal_id":"admin","organization_id":"org-1","email":"alice@example.com","display_name":"Alice","password":"secret","role":"member"}`,
		},
		{
			path: ContractRoutes["add_organization_membership"],
			body: `{"request_id":"membership-request","actor_principal_id":"admin","organization_id":"org-1","user_id":"user-1","role":"member"}`,
		},
	} {
		request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", test.path, response.Code, response.Body.String())
		}
	}
	if services.createOrganizationInput.RequestID != "organization-request" ||
		services.createLocalUserInput.RequestID != "user-request" ||
		services.addMembershipInput.RequestID != "membership-request" {
		t.Fatalf("request IDs were dropped: organization=%#v user=%#v membership=%#v",
			services.createOrganizationInput, services.createLocalUserInput, services.addMembershipInput)
	}
}

func TestRPCRequiresExplicitOIDCProviderEnabledState(t *testing.T) {
	services := &rpcServicesStub{}
	handler := newRPCHandler(t, services)
	request := httptest.NewRequest(http.MethodPost, ContractRoutes["upsert_oidc_provider"], strings.NewReader(`{
		"request_id":"provider-request","actor_principal_id":"admin","organization_id":"org-1",
		"name":"workforce","issuer":"https://id.example.com","client_id":"client",
		"redirect_uri":"https://identity.example.com/protocol/oidc/callback","scopes":["openid"]
	}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || services.upsertProviderCalls != 0 {
		t.Fatalf("omitted upsert enabled status=%d calls=%d body=%s",
			response.Code, services.upsertProviderCalls, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, ContractRoutes["upsert_oidc_provider"], strings.NewReader(`{
		"request_id":"provider-request","actor_principal_id":"admin","organization_id":"org-1",
		"name":"workforce","issuer":"https://id.example.com","client_id":"client",
		"redirect_uri":"https://identity.example.com/protocol/oidc/callback","scopes":["openid"],"enabled":false
	}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || services.upsertProviderCalls != 1 || services.upsertProviderInput.Enabled {
		t.Fatalf("explicit false upsert status=%d calls=%d input=%#v body=%s",
			response.Code, services.upsertProviderCalls, services.upsertProviderInput, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, ContractRoutes["set_oidc_provider_enabled"], strings.NewReader(`{
		"request_id":"disable-request","actor_principal_id":"admin","organization_id":"org-1","name":"workforce"
	}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || services.setProviderEnabledCalls != 0 {
		t.Fatalf("omitted set enabled status=%d calls=%d body=%s",
			response.Code, services.setProviderEnabledCalls, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, ContractRoutes["set_oidc_provider_enabled"], strings.NewReader(`{
		"request_id":"disable-request","actor_principal_id":"admin","organization_id":"org-1",
		"name":"workforce","enabled":false
	}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || services.setProviderEnabledCalls != 1 || services.setProviderEnabledInput.Enabled {
		t.Fatalf("explicit false set status=%d calls=%d input=%#v body=%s",
			response.Code, services.setProviderEnabledCalls, services.setProviderEnabledInput, response.Body.String())
	}
}

func TestRPCBindingsConformToCentralIdentityContract(t *testing.T) {
	encoded, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	var contract struct {
		Definitions struct {
			OrganizationRole struct {
				Enum []string `json:"enum"`
			} `json:"organization_role"`
		} `json:"definitions"`
		Error struct {
			Properties struct {
				Code struct {
					Enum []string `json:"enum"`
				} `json:"code"`
			} `json:"properties"`
			HTTPStatusByCode map[string]int `json:"http_status_by_code"`
		} `json:"error"`
		Methods map[string]struct {
			Method  string `json:"method"`
			Path    string `json:"path"`
			Request struct {
				Required   []string                   `json:"required"`
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"request"`
			Response struct {
				Required   []string                   `json:"required"`
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"response"`
		} `json:"methods"`
		Protocols struct {
			OIDCCallback struct {
				ReplayResponse struct {
					Required  []string `json:"required"`
					Forbidden []string `json:"forbidden"`
				} `json:"replay_response"`
			} `json:"oidc_callback"`
		} `json:"protocols"`
	}
	if err := json.Unmarshal(encoded, &contract); err != nil {
		t.Fatalf("decode contract: %v", err)
	}
	if len(contract.Methods) != len(ContractRoutes) {
		t.Fatalf("contract methods=%d route bindings=%d", len(contract.Methods), len(ContractRoutes))
	}
	for name, method := range contract.Methods {
		if method.Method != http.MethodPost {
			t.Errorf("method %s HTTP method=%q want=%q", name, method.Method, http.MethodPost)
		}
		want := "/rpc/identity" + method.Path
		if got := ContractRoutes[name]; got != want {
			t.Errorf("method %s route=%q want=%q", name, got, want)
		}
		for _, field := range method.Request.Required {
			if _, ok := method.Request.Properties[field]; !ok {
				t.Errorf("method %s required request field %q has no type contract", name, field)
			}
		}
		for _, field := range method.Response.Required {
			if _, ok := method.Response.Properties[field]; !ok {
				t.Errorf("method %s required response field %q has no type contract", name, field)
			}
		}
	}
	if !contains(contract.Methods["add_organization_membership"].Request.Required, "user_id") {
		t.Fatal("add_organization_membership contract must identify the stable user")
	}
	if !contains(contract.Definitions.OrganizationRole.Enum, "member") ||
		!contains(contract.Definitions.OrganizationRole.Enum, "admin") {
		t.Fatal("organization role contract must enumerate member and admin")
	}
	for _, code := range []string{
		"invalid_argument", "unauthenticated", "forbidden", "not_found", "conflict",
		"oidc_exchange_in_progress", "oidc_session_expired", "oidc_completed_token_unavailable",
	} {
		if !contains(contract.Error.Properties.Code.Enum, code) {
			t.Errorf("identity error contract omits stable code %q", code)
		}
	}
	for code, status := range map[string]int{
		"invalid_argument": 400, "unauthenticated": 401, "forbidden": 403,
		"not_found": 404, "conflict": 409, "oidc_session_expired": 410,
	} {
		if contract.Error.HTTPStatusByCode[code] != status {
			t.Errorf("identity error %q status=%d want=%d", code, contract.Error.HTTPStatusByCode[code], status)
		}
	}
	if !contains(contract.Methods["local_login"].Response.Required, "token_id") {
		t.Fatal("local_login contract does not expose the token ID required by revoke_access_token")
	}
	if !contains(contract.Protocols.OIDCCallback.ReplayResponse.Required, "token_id") ||
		!contains(contract.Protocols.OIDCCallback.ReplayResponse.Forbidden, "access_token") {
		t.Fatal("OIDC callback replay contract must expose token identity without redisclosing the credential")
	}
}

func newRPCHandler(t *testing.T, services *rpcServicesStub) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Directory: services, LocalAuth: services, OIDC: services, SCIM: services,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

type rpcServicesStub struct {
	loginCalls              int
	resolveErr              error
	createOrganizationInput directory.CreateOrganizationInput
	createLocalUserInput    directory.CreateLocalUserInput
	addMembershipInput      directory.AddOrganizationMembershipInput
	upsertProviderCalls     int
	upsertProviderInput     oidcflow.UpsertProviderInput
	setProviderEnabledCalls int
	setProviderEnabledInput oidcflow.SetProviderEnabledInput
}

func (s *rpcServicesStub) CreateOrganization(_ context.Context, input directory.CreateOrganizationInput) (domain.Organization, error) {
	s.createOrganizationInput = input
	return domain.Organization{}, nil
}

func (s *rpcServicesStub) CreateLocalUser(_ context.Context, input directory.CreateLocalUserInput) (directory.CreateLocalUserResult, error) {
	s.createLocalUserInput = input
	return directory.CreateLocalUserResult{}, nil
}

func (s *rpcServicesStub) AddOrganizationMembership(
	_ context.Context,
	input directory.AddOrganizationMembershipInput,
) (domain.OrganizationMembership, error) {
	s.addMembershipInput = input
	return domain.OrganizationMembership{}, nil
}

func (*rpcServicesStub) List(context.Context, string, string) (directory.Directory, error) {
	return directory.Directory{}, nil
}

func (s *rpcServicesStub) Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error) {
	s.loginCalls++
	return localauth.LoginResult{}, nil
}

func (s *rpcServicesStub) Resolve(context.Context, string) (domain.Principal, error) {
	return domain.Principal{}, s.resolveErr
}

func (*rpcServicesStub) Revoke(context.Context, string, string) error { return nil }

func (s *rpcServicesStub) UpsertProvider(
	_ context.Context,
	input oidcflow.UpsertProviderInput,
) (oidcflow.Provider, error) {
	s.upsertProviderCalls++
	s.upsertProviderInput = input
	return oidcflow.Provider{}, nil
}

func (s *rpcServicesStub) SetProviderEnabled(
	_ context.Context,
	input oidcflow.SetProviderEnabledInput,
) (oidcflow.Provider, error) {
	s.setProviderEnabledCalls++
	s.setProviderEnabledInput = input
	return oidcflow.Provider{Enabled: input.Enabled}, nil
}

func (*rpcServicesStub) ListLoginMethods(context.Context, string) ([]oidcflow.LoginMethod, error) {
	return nil, nil
}

func (*rpcServicesStub) StartLogin(context.Context, oidcflow.StartLoginInput) (oidcflow.StartLoginResult, error) {
	return oidcflow.StartLoginResult{}, nil
}

func (*rpcServicesStub) CompleteLogin(context.Context, oidcflow.CompleteLoginInput) (oidcflow.CompleteLoginResult, error) {
	return oidcflow.CompleteLoginResult{AccessToken: "credential"}, nil
}

func (*rpcServicesStub) IssueToken(context.Context, scim.IssueTokenInput) (scim.IssueTokenResult, error) {
	return scim.IssueTokenResult{}, nil
}

func (*rpcServicesStub) RevokeToken(context.Context, string, string) error { return nil }

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
