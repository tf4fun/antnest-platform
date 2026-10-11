package rpc

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestBrowserControlResponsesMatchCompleteSchemas(t *testing.T) {
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
	for _, test := range []struct{ method, body string }{
		{"touch_browser_session", `{"actor_principal_id":"admin"}`},
		{"list_user_sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10}`},
		{"revoke_user_sessions", `{"request_id":"r","actor_principal_id":"admin","user_id":"admin","scope":"self","mode":"others"}`},
		{"list_session_revocations", `{"after_sequence":12,"limit":500}`},
		{"change_local_password", `{"request_id":"password-1","actor_principal_id":"admin","user_id":"admin","current_password":"current password value","new_password":"replacement password value"}`},
		{"get_current_account", `{"actor_principal_id":"admin","organization_id":"org-1"}`},
	} {
		t.Run(test.method, func(t *testing.T) {
			h, deps, _, service, cct := browserRPC(t)
			now := time.Now().UTC()
			service.sessions = []browsersessions.Session{{ID: "public-session", OrganizationID: "org-1", OrganizationSlug: "engineering", OrganizationName: "Engineering", CreatedAt: now, LastActiveAt: now, IdleExpiresAt: now.Add(time.Minute), ExpiresAt: now.Add(time.Hour), UserAgentHint: "浏览器", Current: true}}
			service.feedEvents = []domain.SessionRevocation{{Sequence: 13, TokenID: "private-session", UserID: "admin", OrganizationID: "org-1", Reason: "session_revoked", OccurredAt: now}}
			deps.Directory.(*rpcServicesStub).currentAccount = directory.CurrentAccount{UserID: "admin", OrganizationID: "org-1", OrganizationSlug: "engineering", OrganizationName: "Engineering", MembershipID: "membership-1", Email: "admin@example.test", DisplayName: "Administrator", Source: domain.SourceLocal, LocalPasswordAvailable: true}
			if test.method == "list_session_revocations" {
				cct = ""
			}
			response := browserRPCRequest(h, ContractRoutes[test.method], test.body, gatewayTestToken, cct)
			if response.Code != 200 {
				t.Fatalf("contract fixture was not admitted: %d", response.Code)
			}
			schema, err := compiler.Compile(schemaID + "#/methods/" + test.method + "/response")
			if err != nil {
				t.Fatal(err)
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(value); err != nil {
				t.Fatalf("real browser-control handler violates its complete response schema: %v", err)
			}
		})
	}
}
