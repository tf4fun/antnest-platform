package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

type bindingRPCRepository struct {
	calls     int
	bind      externalidentities.BindInput
	unbind    externalidentities.UnbindInput
	err       error
	page      *externalidentities.Page
	providers *externalidentities.ProvidersPage
}

func (r *bindingRPCRepository) List(_ context.Context, a externalidentities.Access, _ externalidentities.ListInput) (externalidentities.Page, error) {
	r.calls++
	if r.page != nil {
		return *r.page, r.err
	}
	page := externalidentities.Page{Bindings: []externalidentities.Binding{}}
	if a.Scope == "self" {
		notices := []externalidentities.Notice{}
		page.Notices = &notices
	}
	return page, r.err
}
func (r *bindingRPCRepository) Bind(_ context.Context, _ externalidentities.Access, input externalidentities.BindInput) (externalidentities.Binding, error) {
	r.calls++
	r.bind = input
	now := time.Now().UTC()
	return externalidentities.Binding{ID: "binding-1", ProviderID: input.ProviderID, ProviderName: "workforce", ProviderDisplayName: "Workforce", OrganizationID: "org-1", OrganizationSlug: "organization", OrganizationName: "Organization", MembershipID: input.MembershipID, Subject: input.Subject, Method: "admin", CreatedAt: now, BoundAt: now}, r.err
}
func (r *bindingRPCRepository) Unbind(_ context.Context, _ externalidentities.Access, input externalidentities.UnbindInput) (externalidentities.UnbindResult, error) {
	r.calls++
	r.unbind = input
	return externalidentities.UnbindResult{}, r.err
}
func (r *bindingRPCRepository) Acknowledge(context.Context, externalidentities.Access, externalidentities.AcknowledgeInput) (externalidentities.AcknowledgeResult, error) {
	r.calls++
	return externalidentities.AcknowledgeResult{}, r.err
}
func (r *bindingRPCRepository) ListProviders(context.Context, externalidentities.Access, externalidentities.ProvidersInput) (externalidentities.ProvidersPage, error) {
	r.calls++
	if r.providers != nil {
		return *r.providers, r.err
	}
	return externalidentities.ProvidersPage{Providers: []externalidentities.Provider{}}, r.err
}

func externalRPC(t *testing.T) (*Handler, Dependencies, *rpcSessionStub, *bindingRPCRepository, string) {
	t.Helper()
	h, deps, sessions, _, cct := browserRPC(t)
	repository := &bindingRPCRepository{}
	h.dependencies.ExternalIdentities = externalidentities.NewService(repository)
	return h, deps, sessions, repository, cct
}

var bindingRPCRequests = []struct{ method, path, body, token string }{
	{"list_external_identities", "list-external-identities", `{"actor_principal_id":"admin","scope":"self","limit":10}`, gatewayTestToken},
	{"list_external_identities", "list-external-identities", `{"actor_principal_id":"admin","scope":"organization","membership_id":"member-1","limit":10}`, consoleTestToken},
	{"bind_external_identity", "bind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","membership_id":"member-1","provider_id":"provider-1","subject":" opaque 😀 ","restore_revoked":false}`, consoleTestToken},
	{"unbind_external_identity", "unbind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","binding_id":"binding-1","scope":"self","allow_lockout":false}`, gatewayTestToken},
	{"unbind_external_identity", "unbind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","binding_id":"binding-1","membership_id":"member-1","scope":"organization","allow_lockout":false}`, consoleTestToken},
	{"acknowledge_external_identity_notices", "acknowledge-external-identity-notices", `{"request_id":"request-1","actor_principal_id":"admin","notice_ids":["notice-1"]}`, gatewayTestToken},
	{"list_external_identity_providers", "list-external-identity-providers", `{"actor_principal_id":"admin","limit":10}`, consoleTestToken},
}

func TestExternalIdentityRPCRequiresWorkloadAndLiveCaller(t *testing.T) {
	for _, route := range bindingRPCRequests {
		for _, auth := range []string{"live", "missing", "forged", "revoked", "wrong-workload"} {
			t.Run(route.path+"/"+auth+"/"+route.token[:2], func(t *testing.T) {
				h, _, sessions, repository, cct := externalRPC(t)
				token, want := route.token, http.StatusOK
				switch auth {
				case "missing":
					cct = ""
					want = http.StatusUnauthorized
				case "forged":
					cct = "invalid"
					want = http.StatusUnauthorized
				case "revoked":
					sessions.err = domain.ErrNotFound
					want = http.StatusUnauthorized
				case "wrong-workload":
					token = controllerTestToken
					want = http.StatusForbidden
				}
				response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, token, cct)
				if response.Code != want {
					t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body.String())
				}
				if auth == "live" && response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("private response is cacheable")
				}
				wantCalls := 0
				if auth == "live" {
					wantCalls = 1
				}
				if repository.calls != wantCalls {
					t.Fatalf("authentication boundary called storage %d times, want %d", repository.calls, wantCalls)
				}
			})
		}
	}
}

func TestExternalIdentityRPCRejectsMixedWorkloadScopes(t *testing.T) {
	for _, route := range bindingRPCRequests {
		if route.method != "list_external_identities" && route.method != "unbind_external_identity" {
			continue
		}
		t.Run(route.path+"/"+route.token[:2], func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			token := gatewayTestToken
			if route.token == gatewayTestToken {
				token = consoleTestToken
			}
			response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, token, cct)
			if response.Code != http.StatusForbidden || repository.calls != 0 {
				t.Fatalf("workload scope escalation status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestExternalIdentityRPCRejectsNullPresenceAndMalformedSubjects(t *testing.T) {
	for _, test := range []struct{ path, body, token string }{
		{"list-external-identities", `{"actor_principal_id":"admin","scope":"self","limit":10,"membership_id":null}`, gatewayTestToken},
		{"list-external-identities", `{"actor_principal_id":"admin","scope":"self","limit":10,"after_id":null}`, gatewayTestToken},
		{"list-external-identities", `{"actor_principal_id":"admin","scope":"organization","membership_id":"member-1","limit":10,"notice_after_id":null}`, consoleTestToken},
		{"unbind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","binding_id":"binding-1","scope":"self","allow_lockout":null}`, gatewayTestToken},
		{"unbind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","binding_id":"binding-1","scope":"self","membership_id":""}`, gatewayTestToken},
		{"bind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","membership_id":"member-1","provider_id":"provider-1","subject":"s","restore_revoked":null}`, consoleTestToken},
		{"bind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","membership_id":"member-1","provider_id":"provider-1","subject":"\uD800"}`, consoleTestToken},
		{"bind-external-identity", `{"request_id":"request-1","actor_principal_id":"admin","membership_id":"member-1","provider_id":"provider-1","subject":"\u0000"}`, consoleTestToken},
		{"acknowledge-external-identity-notices", `{"request_id":"request-1","actor_principal_id":"admin","notice_ids":["notice-1","notice-1"]}`, gatewayTestToken},
		{"list-external-identity-providers", `{"actor_principal_id":"admin","limit":10,"organization_id":"other"}`, consoleTestToken},
	} {
		t.Run(test.path+"/"+test.body, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			response := browserRPCRequest(h, "/rpc/identity/"+test.path, test.body, test.token, cct)
			if response.Code != http.StatusBadRequest || repository.calls != 0 {
				t.Fatalf("malformed request status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestExternalIdentityRPCResponsesMatchCompleteContract(t *testing.T) {
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
	for _, route := range bindingRPCRequests {
		for _, populated := range []bool{false, true} {
			name := "empty"
			if populated {
				name = "populated"
			}
			t.Run(route.method+"/"+route.token[:2]+"/"+name, func(t *testing.T) {
				h, _, _, repository, cct := externalRPC(t)
				if populated {
					now := time.Now().UTC()
					binding := externalidentities.Binding{ID: "binding-1", ProviderID: "provider-1", ProviderName: "workforce", ProviderDisplayName: "Workforce", OrganizationID: "org-1", OrganizationSlug: "organization", OrganizationName: "Organization", MembershipID: "member-1", Subject: " opaque 😀 ", Method: "admin", CreatedAt: now, BoundAt: now, RevokedAt: &now}
					page := externalidentities.Page{Bindings: []externalidentities.Binding{binding}, NextAfterID: binding.ID}
					if route.token == gatewayTestToken {
						notices := []externalidentities.Notice{{ID: "notice-1", BindingID: binding.ID, ProviderID: binding.ProviderID, ProviderName: binding.ProviderName, ProviderDisplayName: binding.ProviderDisplayName, OrganizationID: binding.OrganizationID, OrganizationSlug: binding.OrganizationSlug, OrganizationName: binding.OrganizationName, MembershipID: binding.MembershipID, Subject: binding.Subject, Method: binding.Method, CreatedAt: now}}
						page.Notices = &notices
						page.NextNoticeAfterID = notices[0].ID
					}
					repository.page = &page
					repository.providers = &externalidentities.ProvidersPage{Providers: []externalidentities.Provider{{ID: "provider-1", Name: "workforce", DisplayName: "Workforce", LinkPolicy: "none", LinkDomains: []string{}, Enabled: false, Authoritative: false, LinkPolicyReviewRequired: false}}, NextAfterID: "provider-1"}
				}
				response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, route.token, cct)
				if response.Code != http.StatusOK {
					t.Fatalf("response status=%d body=%s", response.Code, response.Body.String())
				}
				schema, err := compiler.Compile(schemaID + "#/methods/" + route.method + "/response")
				if err != nil {
					t.Fatal(err)
				}
				value, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
				if err != nil {
					t.Fatal(err)
				}
				if err := schema.Validate(value); err != nil {
					t.Fatalf("actual response violates complete schema: %v", err)
				}
				if route.method == "bind_external_identity" {
					var body struct {
						Binding externalidentities.Binding `json:"binding"`
					}
					if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Binding.Subject != " opaque 😀 " {
						t.Fatal("opaque subject was normalized")
					}
				}
				for _, secret := range []string{`"user_id"`, `"issuer"`, `"client_secret"`, `"access_token"`, `"session_id"`} {
					if strings.Contains(response.Body.String(), secret) {
						t.Fatalf("unexpected private field %s", secret)
					}
				}
			})
		}
	}
}

func TestExternalIdentityRPCUsesOrganizationRoleAndExactWorkload(t *testing.T) {
	for _, role := range []domain.OrganizationRole{domain.OrganizationRoleAdmin, domain.OrganizationRoleMember} {
		for _, route := range bindingRPCRequests {
			if route.token != consoleTestToken {
				continue
			}
			t.Run(string(role)+"/"+route.method, func(t *testing.T) {
				h, deps, sessions, repository, _ := externalRPC(t)
				sessions.session.Principal.SystemRole = domain.SystemRoleUser
				sessions.session.Principal.OrganizationRole = role
				_, cct, err := deps.CallerContext.Issue(t.Context(), "raw-credential", "session", "")
				if err != nil {
					t.Fatal(err)
				}
				response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, route.token, cct)
				want, calls := http.StatusOK, 1
				if role == domain.OrganizationRoleMember {
					want, calls = http.StatusForbidden, 0
				}
				if response.Code != want || repository.calls != calls {
					t.Fatalf("role boundary: status=%d calls=%d body=%s", response.Code, repository.calls, response.Body.String())
				}
			})
		}
	}
	for _, route := range bindingRPCRequests {
		if route.method != "bind_external_identity" && route.method != "acknowledge_external_identity_notices" {
			continue
		}
		t.Run(route.method+"/opposite-workload", func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			token := gatewayTestToken
			if route.token == gatewayTestToken {
				token = consoleTestToken
			}
			response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, token, cct)
			if response.Code != http.StatusForbidden || repository.calls != 0 {
				t.Fatalf("wrong workload: status=%d calls=%d", response.Code, repository.calls)
			}
		})
	}
}

func TestExternalIdentityRPCPreservesExplicitBooleanFlags(t *testing.T) {
	for _, route := range bindingRPCRequests {
		if route.method != "bind_external_identity" && route.method != "unbind_external_identity" {
			continue
		}
		field := "allow_lockout"
		if route.method == "bind_external_identity" {
			field = "restore_revoked"
		}
		for _, variant := range []string{"omitted", "false", "true"} {
			t.Run(route.path+"/"+route.token[:2]+"/"+variant, func(t *testing.T) {
				h, _, _, repository, cct := externalRPC(t)
				var fields map[string]any
				if err := json.Unmarshal([]byte(route.body), &fields); err != nil {
					t.Fatal(err)
				}
				delete(fields, field)
				if variant != "omitted" {
					fields[field] = variant == "true"
				}
				raw, err := json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				response := browserRPCRequest(h, "/rpc/identity/"+route.path, string(raw), route.token, cct)
				got := repository.unbind.AllowLockout
				if field == "restore_revoked" {
					got = repository.bind.RestoreRevoked
				}
				if response.Code != http.StatusOK || repository.calls != 1 || got != (variant == "true") {
					t.Fatalf("boolean flag changed: status=%d calls=%d flag=%t", response.Code, repository.calls, got)
				}
			})
		}
	}
}

func TestExternalIdentityRPCMapsBindingConflictsTo409(t *testing.T) {
	for _, code := range []string{"external_identity_conflict", "external_identity_restore_required", "external_identity_last_method"} {
		t.Run(code, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			repository.err = domain.NewError(code, "binding rejected", false)
			route := bindingRPCRequests[2]
			if code == "external_identity_last_method" {
				route = bindingRPCRequests[4]
			}
			response := browserRPCRequest(h, "/rpc/identity/"+route.path, route.body, route.token, cct)
			var body struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusConflict || body.Code != code || body.Retryable || repository.calls != 1 {
				t.Fatalf("conflict mapping: status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}
