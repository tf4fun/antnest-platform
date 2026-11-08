package rpc

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func rpcPageRequest(
	t *testing.T,
	deps Dependencies,
	path string,
	body string,
	workload string,
) *httptest.ResponseRecorder {
	t.Helper()
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := deps.CallerContext.Issue(t.Context(), "access-token", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if workload != "" {
		request.Header.Set(serviceauth.Header, "Bearer "+workload)
	}
	request.Header.Set(callercontext.Header, token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func validatePageSchema(t *testing.T, body []byte, def string) {
	t.Helper()
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	compiler := newIdentitySchemaCompiler(t)
	raw, err := os.ReadFile("../../../../contracts/identity/directory.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	resource, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err := compiler.AddResource(
		"https://schemas.antnest.dev/identity/directory.schema.json", resource,
	); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(
		"https://schemas.antnest.dev/identity/directory.schema.json#/$defs/" + def,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(document); err != nil {
		t.Fatalf("response fails %s: %v", def, err)
	}
}

func memberSample() directory.Member {
	return directory.Member{
		User: domain.User{
			ID: "user-1", SystemRole: domain.SystemRoleUser, Active: true,
			CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		},
		Membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
			Email: "member@example.com", DisplayName: "Member",
			Role: domain.OrganizationRoleMember, Source: domain.SourceLocal,
			Active: true, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		},
	}
}

func TestListMembersRPCHandler(t *testing.T) {
	services := &rpcServicesStub{
		memberPage: directory.MemberPage{Items: []directory.Member{memberSample()}},
	}
	deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
	response := rpcPageRequest(t, deps, "/rpc/identity/list-members",
		`{"actor_principal_id":"admin","organization_id":"org-1","limit":5}`, consoleTestToken)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	validatePageSchema(t, response.Body.Bytes(), "list_members_response")
	var page struct {
		Items      []directory.Member `json:"items"`
		NextCursor *string            `json:"next_cursor"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Membership.Email != "member@example.com" ||
		page.NextCursor != nil {
		t.Fatalf("page = %+v", page)
	}
	if services.membersInput.Limit != 5 || services.membersInput.ActorPrincipalID != "admin" {
		t.Fatalf("service input = %+v", services.membersInput)
	}
}

func TestListGroupsRPCHandler(t *testing.T) {
	services := &rpcServicesStub{
		groupPage: directory.GroupPage{Items: []domain.Group{{
			ID: "group-1", OrganizationID: "org-1", DisplayName: "Ops",
			Source: domain.SourceLocal, Active: true,
			CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}}},
	}
	deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
	response := rpcPageRequest(t, deps, "/rpc/identity/list-groups",
		`{"actor_principal_id":"admin","organization_id":"org-1","limit":10,"filter":{"display_name_prefix":"op","active":true}}`,
		consoleTestToken)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	validatePageSchema(t, response.Body.Bytes(), "list_groups_response")
	if services.groupsInput.Filter.DisplayNamePrefix != "op" ||
		services.groupsInput.Filter.Active == nil || !*services.groupsInput.Filter.Active {
		t.Fatalf("filter input = %+v", services.groupsInput.Filter)
	}
}

func TestListMembersRejectsMalformedBodiesBeforeServiceCall(t *testing.T) {
	for name, body := range map[string]string{
		"limit missing":     `{"actor_principal_id":"admin","organization_id":"org-1"}`,
		"limit null":        `{"actor_principal_id":"admin","organization_id":"org-1","limit":null}`,
		"limit zero":        `{"actor_principal_id":"admin","organization_id":"org-1","limit":0}`,
		"limit overbound":   `{"actor_principal_id":"admin","organization_id":"org-1","limit":201}`,
		"limit string":      `{"actor_principal_id":"admin","organization_id":"org-1","limit":"5"}`,
		"cursor null":       `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"cursor":null}`,
		"cursor empty":      `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"cursor":""}`,
		"cursor nonstring":  `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"cursor":5}`,
		"filter duplicate":  `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"role":"admin","role":"member"}}`,
		"filter null":       `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":null}`,
		"filter nonobject":  `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":"x"}`,
		"filter unknown":    `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"bogus":1}}`,
		"filter null field": `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"active":null}}`,
		"filter bad type":   `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"active":"yes"}}`,
		"filter bad role":   `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"role":"owner"}}`,
		"unknown field":     `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"bogus":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			services := &rpcServicesStub{
				memberPage: directory.MemberPage{Items: []directory.Member{}},
			}
			deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
			response := rpcPageRequest(t, deps, "/rpc/identity/list-members", body, consoleTestToken)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if services.membersCalls != 0 {
				t.Fatal("service must not be called for malformed input")
			}
		})
	}
	services := &rpcServicesStub{
		membersErr: domain.InvalidArgument("cursor is invalid"),
	}
	deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
	response := rpcPageRequest(t, deps, "/rpc/identity/list-members",
		`{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"cursor":"not-a-cursor"}`,
		consoleTestToken)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if services.membersCalls != 1 {
		t.Fatal("a syntactically valid cursor reaches the service for domain validation")
	}
}

func TestDirectoryPagesRejectUnauthorizedCallers(t *testing.T) {
	for _, path := range []string{"/rpc/identity/list-members", "/rpc/identity/list-groups"} {
		for name, configure := range map[string]func(*testing.T, Dependencies, *http.Request){
			"missing workload": func(t *testing.T, _ Dependencies, request *http.Request) {
				request.Header.Del(serviceauth.Header)
			},
			"wrong workload": func(t *testing.T, _ Dependencies, request *http.Request) {
				request.Header.Set(serviceauth.Header, "Bearer "+gatewayTestToken)
			},
			"missing caller context": func(t *testing.T, _ Dependencies, request *http.Request) {
				request.Header.Del(callercontext.Header)
			},
			"forged caller context": func(t *testing.T, _ Dependencies, request *http.Request) {
				request.Header.Set(callercontext.Header, "forged")
			},
			"actor mismatch":        func(t *testing.T, _ Dependencies, request *http.Request) {},
			"organization mismatch": func(t *testing.T, _ Dependencies, request *http.Request) {},
		} {
			t.Run(path+"/"+name, func(t *testing.T) {
				services := &rpcServicesStub{
					memberPage: directory.MemberPage{Items: []directory.Member{}},
					groupPage:  directory.GroupPage{Items: []domain.Group{}},
				}
				deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
				handler, err := NewHandler(deps)
				if err != nil {
					t.Fatal(err)
				}
				actor, organization := "admin", "org-1"
				if name == "actor mismatch" {
					actor = "victim"
				}
				if name == "organization mismatch" {
					organization = "victim-org"
				}
				body := `{"actor_principal_id":"` + actor + `","organization_id":"` + organization + `","limit":5}`
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set(serviceauth.Header, "Bearer "+consoleTestToken)
				_, token, err := deps.CallerContext.Issue(t.Context(), "access-token", "console", "")
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set(callercontext.Header, token)
				configure(t, deps, request)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code == http.StatusOK {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				if services.membersCalls+services.groupsCalls != 0 {
					t.Fatal("service must not be called for unauthorized callers")
				}
			})
		}
	}
}

func TestListGroupsRejectsMalformedBodies(t *testing.T) {
	for name, body := range map[string]string{
		"limit missing":   `{"actor_principal_id":"admin","organization_id":"org-1"}`,
		"limit overbound": `{"actor_principal_id":"admin","organization_id":"org-1","limit":201}`,
		"filter role":     `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"role":"admin"}}`,
		"filter source":   `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"filter":{"source":"oidc"}}`,
		"cursor null":     `{"actor_principal_id":"admin","organization_id":"org-1","limit":5,"cursor":null}`,
	} {
		t.Run(name, func(t *testing.T) {
			services := &rpcServicesStub{
				groupPage: directory.GroupPage{Items: []domain.Group{}},
			}
			deps, _ := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
			response := rpcPageRequest(t, deps, "/rpc/identity/list-groups", body, consoleTestToken)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if services.groupsCalls != 0 {
				t.Fatal("service must not be called for malformed input")
			}
		})
	}
}
