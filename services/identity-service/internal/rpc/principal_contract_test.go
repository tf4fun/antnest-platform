package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestPrincipalResponsesValidateAgainstContract(t *testing.T) {
	const schemaID = "https://antnest.local/contracts/identity/identity-contract.json"
	data, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(schemaID, document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(schemaID + "#/definitions/principal")
	if err != nil {
		t.Fatal(err)
	}
	var principal domain.Principal
	if err := json.Unmarshal([]byte(`{"user_id":"user-1","organization_id":"org-1","organization_slug":"engineering","organization_name":"Engineering","membership_id":"member-1","system_role":"user","organization_role":"member","active":true}`), &principal); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, method, path, body string
		replayed                 bool
	}{
		{"local_login", http.MethodPost, ContractRoutes["local_login"], `{"request_id":"login-1","organization_slug":"engineering","email":"member@example.com","password":"password"}`, false},
		{"resolve_access_token", http.MethodPost, ContractRoutes["resolve_access_token"], `{"access_token":"ant_api_contract"}`, false},
		{"oidc_initial", http.MethodGet, "/protocol/oidc/callback?state=state&code=code", "", false},
		{"oidc_replay", http.MethodGet, "/protocol/oidc/callback?state=state&code=code", "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			services := &principalContractServices{rpcServicesStub: &rpcServicesStub{}, principal: principal, replayed: test.replayed}
			handler, err := NewHandler(Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
			if response.Code != http.StatusOK {
				t.Fatalf("HTTP %d: %s", response.Code, response.Body.String())
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			envelope, ok := value.(map[string]any)
			if !ok {
				t.Fatal("handler response is not an object")
			}
			actual, ok := envelope["principal"].(map[string]any)
			if !ok {
				t.Fatal("handler response has no principal object")
			}
			if err := schema.Validate(actual); err != nil {
				t.Fatalf("real handler principal violates the central contract: %v", err)
			}
			if actual["organization_slug"] != "engineering" || actual["organization_name"] != "Engineering" {
				t.Fatal("handler did not preserve the organization's display fields")
			}
			for _, field := range []string{"organization_slug", "organization_name"} {
				for _, invalid := range []any{nil, "", false} {
					candidate := make(map[string]any, len(actual))
					for key, item := range actual {
						candidate[key] = item
					}
					if invalid == nil {
						delete(candidate, field)
					} else {
						candidate[field] = invalid
					}
					if schema.Validate(candidate) == nil {
						t.Fatalf("central schema accepted invalid %s=%v", field, invalid)
					}
				}
			}
		})
	}
}

type principalContractServices struct {
	*rpcServicesStub
	principal domain.Principal
	replayed  bool
}

func (s *principalContractServices) Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error) {
	return localauth.LoginResult{Principal: s.principal, TokenID: "token-1", AccessToken: "ant_api_contract", ExpiresAt: time.Now().Add(time.Hour)}, nil
}

func (s *principalContractServices) Resolve(context.Context, string) (domain.Principal, error) {
	return s.principal, nil
}

func (s *principalContractServices) CompleteLogin(context.Context, oidcflow.CompleteLoginInput) (oidcflow.CompleteLoginResult, error) {
	result := oidcflow.CompleteLoginResult{Principal: s.principal, TokenID: "token-1", ExpiresAt: time.Now().Add(time.Hour), AlreadyCompleted: s.replayed}
	if !s.replayed {
		result.AccessToken = "ant_api_contract"
	}
	return result, nil
}
