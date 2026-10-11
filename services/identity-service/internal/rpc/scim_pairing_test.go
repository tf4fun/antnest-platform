package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

type pairedTokenRPCService struct {
	rpcServicesStub
	calls      int
	input      scim.IssueTokenInput
	providerID *string
}

func (s *pairedTokenRPCService) IssueToken(_ context.Context, input scim.IssueTokenInput) (scim.IssueTokenResult, error) {
	s.calls++
	s.input = input
	return scim.IssueTokenResult{Token: scim.Token{ID: "scim-token-1", OrganizationID: input.OrganizationID, Name: input.Name, Scopes: input.Scopes, OIDCProviderID: s.providerID, CreatedAt: time.Now().UTC()}, Credential: "synthetic-scim-credential"}, nil
}

func TestSCIMPairingRPCAcceptsExactOptionalProviderID(t *testing.T) {
	for _, test := range []struct {
		name, fields  string
		valid, paired bool
	}{
		{name: "omitted", valid: true},
		{name: "paired", fields: `,"oidc_provider_id":"provider-1"`, valid: true, paired: true},
		{name: "null", fields: `,"oidc_provider_id":null`},
		{name: "empty", fields: `,"oidc_provider_id":""`},
		{name: "url", fields: `,"oidc_provider_id":"https://idp.example.com"`},
		{name: "array", fields: `,"oidc_provider_id":["provider-1"]`},
		{name: "unknown_field", fields: `,"provider_id":"provider-1"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, deps, sessions, _, _ := browserRPC(t)
			sessions.session.Principal.SystemRole = domain.SystemRoleUser
			_, cct, err := deps.CallerContext.Issue(t.Context(), "raw-credential", "console", "")
			if err != nil {
				t.Fatal(err)
			}
			service := &pairedTokenRPCService{}
			if test.paired {
				providerID := "provider-1"
				service.providerID = &providerID
			}
			h.dependencies.SCIM = service
			body := `{"request_id":"paired-token","actor_principal_id":"admin","organization_id":"org-1","name":"Paired directory","scopes":["scim:read","scim:write"]` + test.fields + `}`
			response := browserRPCRequest(h, ContractRoutes["issue_scim_token"], body, consoleTestToken, cct)
			want, calls := http.StatusBadRequest, 0
			if test.valid {
				if (service.input.OIDCProviderID != nil) != test.paired || test.paired && *service.input.OIDCProviderID != "provider-1" {
					t.Fatal("pairing authorization was not forwarded exactly")
				}
				want, calls = http.StatusOK, 1
			}
			if response.Code != want || service.calls != calls {
				t.Fatalf("pairing RPC status=%d want=%d calls=%d body=%s", response.Code, want, service.calls, response.Body.String())
			}
			if test.valid {
				var got scim.IssueTokenResult
				if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if (got.Token.OIDCProviderID != nil) != test.paired || test.paired && *got.Token.OIDCProviderID != "provider-1" {
					t.Fatal("pairing metadata changed")
				}
			}
		})
	}
}
