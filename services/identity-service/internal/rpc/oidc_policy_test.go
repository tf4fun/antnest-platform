package rpc

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Shared revision 16 precedes the next Identity lifecycle batch. These exact
// methods must remain absent from runtime routes and active workload grants
// until that batch implements and admits them.
var pendingOIDCLinkingMethods = map[string]bool{
	"list_external_identities":              true,
	"bind_external_identity":                true,
	"unbind_external_identity":              true,
	"acknowledge_external_identity_notices": true,
	"list_external_identity_providers":      true,
}

func TestOIDCPolicyRPCPreservesOmissionAndExplicitFalse(t *testing.T) {
	for _, test := range []struct {
		name, fields    string
		valid, supplied bool
	}{
		{name: "omitted", valid: true},
		{name: "complete_false", fields: `,"link_policy":"none","link_domains":[],"authoritative":false,"acknowledge_link_policy_review":false`, valid: true, supplied: true},
		{name: "policy_only", fields: `,"link_policy":"none"`},
		{name: "ack_only", fields: `,"acknowledge_link_policy_review":false`},
		{name: "null_policy", fields: `,"link_policy":null,"link_domains":[],"authoritative":false`},
		{name: "null_domains", fields: `,"link_policy":"none","link_domains":null,"authoritative":false`},
		{name: "null_authority", fields: `,"link_policy":"none","link_domains":[],"authoritative":null`},
		{name: "null_ack", fields: `,"link_policy":"none","link_domains":[],"authoritative":false,"acknowledge_link_policy_review":null`},
		{name: "all_null", fields: `,"link_policy":null,"link_domains":null,"authoritative":null`},
		{name: "domains_null_element", fields: `,"link_policy":"verified_email_in_domains","link_domains":[null],"authoritative":false`},
		{name: "wrong_boolean", fields: `,"link_policy":"none","link_domains":[],"authoritative":"false"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			services := &rpcServicesStub{}
			handler := newRPCHandler(t, services)
			body := `{"request_id":"policy","actor_principal_id":"admin","organization_id":"org-1","name":"workforce","issuer":"https://id.example.com","client_id":"client","scopes":["openid"],"enabled":false` + test.fields + `}`
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes["upsert_oidc_provider"], strings.NewReader(body)))
			if !test.valid {
				if response.Code != 400 || services.upsertProviderCalls != 0 {
					t.Fatalf("invalid policy status=%d writes=%d", response.Code, services.upsertProviderCalls)
				}
				return
			}
			if response.Code != 200 || services.upsertProviderCalls != 1 {
				t.Fatalf("valid policy status=%d writes=%d", response.Code, services.upsertProviderCalls)
			}
			input := services.upsertProviderInput
			if !test.supplied {
				if input.LinkPolicy != nil || input.LinkDomains != nil || input.Authoritative != nil || input.AcknowledgeLinkPolicyReview != nil {
					t.Fatal("omission was converted to an explicit policy update")
				}
			} else if input.LinkPolicy == nil || *input.LinkPolicy != "none" || input.LinkDomains == nil || *input.LinkDomains == nil || len(*input.LinkDomains) != 0 || input.Authoritative == nil || *input.Authoritative || input.AcknowledgeLinkPolicyReview == nil || *input.AcknowledgeLinkPolicyReview {
				t.Fatal("explicit empty array or false was lost")
			}
		})
	}
}
