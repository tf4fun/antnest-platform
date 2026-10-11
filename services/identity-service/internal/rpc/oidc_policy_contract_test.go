package rpc

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestOIDCPolicyRealRPCResponsesMatchCompleteContract(t *testing.T) {
	const schemaID = "https://antnest.local/contracts/identity/identity-contract.json"
	raw, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	compiler := newIdentitySchemaCompiler()
	if err := compiler.AddResource(schemaID, document); err != nil {
		t.Fatal(err)
	}
	provider := oidcflow.Provider{
		ID: "provider-1", OrganizationID: "org-1", Name: "workforce", DisplayName: "Workforce",
		Issuer: "https://id.example.com", ClientID: "client-1", Scopes: []string{"openid", "email"}, Enabled: true, Revision: 2,
		LinkPolicy: "none", LinkDomains: []string{}, Authoritative: false, LinkPolicyReviewRequired: true,
		AuthorizationEndpoint: "https://id.example.com/authorize", TokenEndpoint: "https://id.example.com/token", TokenEndpointAuthMethod: "client_secret_basic",
		IDTokenSigningAlgs: []string{"RS256"}, JWKSURI: "https://id.example.com/jwks", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		ClientSecret: credentials.SealedSecret{Ciphertext: []byte("never-expose-provider-secret")},
	}
	for _, method := range []string{"upsert_oidc_provider", "set_oidc_provider_enabled", "list_oidc_providers"} {
		t.Run(method, func(t *testing.T) {
			services := &rpcServicesStub{providers: []oidcflow.Provider{provider}, providerResult: provider}
			body := `{"actor_principal_id":"admin","organization_id":"org-1"}`
			if method == "set_oidc_provider_enabled" {
				body = `{"request_id":"policy","actor_principal_id":"admin","organization_id":"org-1","name":"workforce","enabled":true}`
			}
			if method == "upsert_oidc_provider" {
				body = `{"request_id":"policy","actor_principal_id":"admin","organization_id":"org-1","name":"workforce","issuer":"https://id.example.com","client_id":"client-1","enabled":true,"link_policy":"none","link_domains":[],"authoritative":false}`
			}
			response := httptest.NewRecorder()
			newRPCHandler(t, services).ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes[method], strings.NewReader(body)))
			if response.Code != http.StatusOK {
				t.Fatalf("RPC status=%d body=%s", response.Code, response.Body.String())
			}
			schema, err := compiler.Compile(schemaID + "#/methods/" + method + "/response")
			if err != nil {
				t.Fatal(err)
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(value); err != nil {
				t.Fatalf("actual Provider response violates contract: %v", err)
			}
			if strings.Contains(response.Body.String(), `"client_secret"`) || strings.Contains(response.Body.String(), "never-expose") {
				t.Fatal("Provider response exposed credentials")
			}
		})
	}
}

func TestUnpairedSCIMTokenRealRPCResponsesMatchCompleteContract(t *testing.T) {
	const schemaID = "https://antnest.local/contracts/identity/identity-contract.json"
	raw, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	compiler := newIdentitySchemaCompiler()
	if err := compiler.AddResource(schemaID, document); err != nil {
		t.Fatal(err)
	}
	token := scim.Token{ID: "token-1", OrganizationID: "org-1", Name: "directory", Scopes: []string{"scim:read", "scim:write"}, CreatedAt: time.Now().UTC()}
	for _, method := range []string{"issue_scim_token", "list_scim_tokens"} {
		t.Run(method, func(t *testing.T) {
			services := &rpcServicesStub{scimTokens: []scim.Token{token}}
			body := `{"actor_principal_id":"admin","organization_id":"org-1"}`
			if method == "issue_scim_token" {
				body = `{"request_id":"scim-token","actor_principal_id":"admin","organization_id":"org-1","name":"directory","scopes":["scim:read","scim:write"]}`
			}
			response := httptest.NewRecorder()
			newRPCHandler(t, services).ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes[method], strings.NewReader(body)))
			if response.Code != http.StatusOK {
				t.Fatalf("RPC status=%d body=%s", response.Code, response.Body.String())
			}
			schema, err := compiler.Compile(schemaID + "#/methods/" + method + "/response")
			if err != nil {
				t.Fatal(err)
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(value); err != nil {
				t.Fatalf("actual SCIM response violates contract: %v", err)
			}
			if !strings.Contains(response.Body.String(), `"oidc_provider_id":null`) {
				t.Fatal("unpaired token must explicitly return null")
			}
			if method == "list_scim_tokens" && strings.Contains(response.Body.String(), "test-scim-credential") {
				t.Fatal("token list exposed credential")
			}
		})
	}
}
