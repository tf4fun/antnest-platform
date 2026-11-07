package rpc

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

var updateGolden = flag.Bool("update", false, "rewrite captured golden contract documents")

func writeGoldenDocument(t *testing.T, path string, body []byte) {
	t.Helper()
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("golden candidate is not JSON: %v", err)
	}
	indented, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(indented, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertJSONEqual(t *testing.T, expected, actual []byte) {
	t.Helper()
	var expectedDocument, actualDocument any
	if err := json.Unmarshal(expected, &expectedDocument); err != nil {
		t.Fatalf("golden document is not JSON: %v", err)
	}
	if err := json.Unmarshal(actual, &actualDocument); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if !reflect.DeepEqual(expectedDocument, actualDocument) {
		t.Fatalf("document differs\nexpected: %s\nactual:   %s", expected, actual)
	}
}

type goldenIdentityServices struct {
	*rpcServicesStub
	principal domain.Principal
	fixed     time.Time
}

func (s *goldenIdentityServices) Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error) {
	return localauth.LoginResult{
		Principal: s.principal, TokenID: "token-1", AccessToken: "ant_api_contract",
		ExpiresAt: s.fixed.Add(time.Hour), IdleExpiresAt: s.fixed.Add(30 * time.Minute),
		ActivityIntervalMS: 30000,
	}, nil
}

func (s *goldenIdentityServices) Resolve(context.Context, string) (domain.Principal, error) {
	return s.principal, nil
}

func (s *goldenIdentityServices) ResolvePrincipal(context.Context, string, string) (domain.Principal, error) {
	return s.principal, nil
}

func (s *goldenIdentityServices) ListLoginMethods(context.Context, string) ([]oidcflow.LoginMethod, error) {
	return []oidcflow.LoginMethod{{Name: "local", DisplayName: "Local"}}, nil
}

func TestIdentityProducerGoldens(t *testing.T) {
	t.Parallel()

	fixed := time.Date(2099, 9, 1, 0, 0, 0, 0, time.UTC)
	principal := domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", OrganizationSlug: "engineering",
		OrganizationName: "Engineering", MembershipID: "membership-1",
		SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleMember, Active: true,
	}
	services := &goldenIdentityServices{rpcServicesStub: &rpcServicesStub{}, principal: principal, fixed: fixed}
	deps, sessions := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
	sessions.session.Principal = principal
	sessions.session.ExpiresAt = fixed.Add(time.Hour)
	sessions.session.IdleExpiresAt = fixed.Add(30 * time.Minute)
	sessions.session.ActivityIntervalMS = 30000
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))
	authority, err := callercontext.NewAuthority(callercontext.Config{
		KID:        "golden-test",
		PrivateKey: private,
		Keys:       callercontext.Keys{"golden-test": private.Public().(ed25519.PublicKey)},
		Repository: sessions,
		Now:        func() time.Time { return fixed },
		NewID:      func() string { return "authtoken_11111111111111111111111111111111" },
	})
	if err != nil {
		t.Fatal(err)
	}
	deps.CallerContext = authority
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}

	const schemaID = "https://schemas.antnest.dev/identity/identity-contract.json"
	data, err := os.ReadFile("../../../../contracts/identity/identity-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	compiler := newIdentitySchemaCompiler(t)
	if err := compiler.AddResource(schemaID, document); err != nil {
		t.Fatal(err)
	}

	for _, golden := range []struct {
		name  string
		route string
		token string
		body  string
	}{
		{name: "local-login", route: ContractRoutes["local_login"], token: gatewayTestToken,
			body: `{"request_id":"login-1","organization_slug":"engineering","email":"member@example.com","password":"password"}`},
		{name: "resolve-access-token", route: ContractRoutes["resolve_access_token"], token: gatewayTestToken,
			body: `{"access_token":"ant_api_contract","profile":"console"}`},
		{name: "list-login-methods", route: ContractRoutes["list_login_methods"], token: gatewayTestToken,
			body: `{"organization_slug":"engineering"}`},
		{name: "resolve-principal", route: ContractRoutes["resolve_principal"], token: controllerTestToken,
			body: `{"user_id":"user-1","organization_id":"org-1"}`},
	} {
		t.Run(golden.name, func(t *testing.T) {
			method := strings.ReplaceAll(golden.name, "-", "_")
			definition, err := compiler.Compile(schemaID + "#/methods/" + method + "/response")
			if err != nil {
				t.Fatalf("compile %s response contract: %v", method, err)
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, golden.route, strings.NewReader(golden.body))
			request.Header.Set(serviceauth.Header, "Bearer "+golden.token)
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("%s HTTP %d: %s", golden.name, response.Code, response.Body.String())
			}
			body := response.Body.Bytes()
			instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if err := definition.Validate(instance); err != nil {
				t.Fatalf("%s response violates the method contract: %v", golden.name, err)
			}
			file := "../../../../contracts/identity/examples/" + golden.name + ".member.json"
			if *updateGolden {
				writeGoldenDocument(t, file, body)
			}
			expected, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read golden %s: %v (run with -update)", file, err)
			}
			assertJSONEqual(t, expected, body)
		})
	}
}
