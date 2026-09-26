package scim

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestIssueTokenRequiresOrganizationAdministrationAndStoresHashOnly(t *testing.T) {
	repository := &scimRepositoryStub{principal: scimAdmin()}
	service := newSCIMTestService(t, repository)
	result, err := service.IssueToken(context.Background(), IssueTokenInput{
		RequestID: "request-1", ActorPrincipalID: "admin", OrganizationID: "org-1",
		Name: " Workday provisioning ", Scopes: []string{domain.SCIMScopeWrite, domain.SCIMScopeRead},
	})
	if err != nil {
		t.Fatalf("issue SCIM token: %v", err)
	}
	if repository.issued.TokenID != "scimtoken-1" || result.Credential == "" || repository.issued.TokenHash != credentials.HashToken(result.Credential) ||
		repository.issued.TokenHash == result.Credential {
		t.Fatalf("issued token = %#v credential=%q", repository.issued, result.Credential)
	}
	if repository.issued.Name != "Workday provisioning" || len(repository.issued.Scopes) != 2 {
		t.Fatalf("issued token metadata = %#v", repository.issued)
	}

	repository.principal = domain.Principal{UserID: "member", OrganizationID: "org-1", Active: true}
	_, err = service.IssueToken(context.Background(), IssueTokenInput{
		ActorPrincipalID: "member", OrganizationID: "org-1", Name: "denied", Scopes: []string{domain.SCIMScopeRead},
	})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member issue error = %v, want forbidden", err)
	}
}

func TestListTokensRequiresOrganizationAdministration(t *testing.T) {
	revokedAt := time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC)
	repository := &scimRepositoryStub{tokens: []Token{{
		ID: "token-1", OrganizationID: "org-1", Name: "Workday",
		Scopes: []string{domain.SCIMScopeRead}, RevokedAt: &revokedAt,
	}}}
	service := newSCIMTestService(t, repository)

	repository.principal = domain.Principal{UserID: "member", OrganizationID: "org-1", Active: true}
	_, err := service.ListTokens(context.Background(), "member", "org-1")
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member list error = %v, want forbidden", err)
	}
	if repository.listTokensCalls != 0 {
		t.Fatalf("unauthorized list reached repository %d times", repository.listTokensCalls)
	}

	repository.principal = scimAdmin()
	tokens, err := service.ListTokens(context.Background(), "admin", "org-1")
	if err != nil {
		t.Fatalf("list SCIM tokens: %v", err)
	}
	if len(tokens) != 1 || tokens[0].RevokedAt == nil || repository.listTokensCalls != 1 {
		t.Fatalf("tokens=%#v calls=%d", tokens, repository.listTokensCalls)
	}
}

func TestAuthorizeRequiresRequestedScopeAndHashesBearer(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{domain.SCIMScopeRead},
	}}
	service := newSCIMTestService(t, repository)
	authorization, err := service.Authorize(context.Background(), "ant_scim_secret", domain.SCIMScopeRead)
	if err != nil || authorization.OrganizationID != "org-1" {
		t.Fatalf("authorize = %#v, %v", authorization, err)
	}
	if repository.resolvedHash != credentials.HashToken("ant_scim_secret") {
		t.Fatal("repository did not receive hashed bearer")
	}
	_, err = service.Authorize(context.Background(), "ant_scim_secret", domain.SCIMScopeWrite)
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("write authorization error = %v, want forbidden", err)
	}
}

func TestCreateUserBuildsOrganizationScopedSCIMMembership(t *testing.T) {
	repository := &scimRepositoryStub{}
	service := newSCIMTestService(t, repository)
	result, err := service.CreateUser(context.Background(), Authorization{
		TokenID: "scim-token-1", OrganizationID: "org-1",
	}, UserInput{
		ExternalID: "workday-42", UserName: " Alice.Employee ", Email: "Alice@Example.COM",
		DisplayName: " Alice ", Active: true,
	})
	if err != nil {
		t.Fatalf("create SCIM user: %v", err)
	}
	if result.User.SystemRole != domain.SystemRoleUser || result.Membership.Email != "alice@example.com" ||
		result.Membership.DisplayName != "Alice" || result.Membership.SCIMUserName != "alice.employee" ||
		result.Membership.OrganizationID != "org-1" || result.Membership.Source != domain.SourceSCIM ||
		result.Membership.SCIMExternalID != "workday-42" || result.Membership.ID == result.User.ID {
		t.Fatalf("SCIM user = %#v", result)
	}
	if result.User.ID != "user-1" || result.Membership.ID != "membership-2" || repository.createdUser.ActorTokenID != "scim-token-1" {
		t.Fatalf("SCIM actor token was dropped: %#v", repository.createdUser)
	}
}

func TestReplaceUserOnlyChangesOrganizationMembershipActivation(t *testing.T) {
	repository := &scimRepositoryStub{user: UserResource{
		User: domain.User{
			ID: "user-1", SystemRole: domain.SystemRoleUser, Active: true,
		},
		Membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
			Email: "alice@example.com", DisplayName: "Alice",
			SCIMUserName: "alice.employee", Source: domain.SourceSCIM, Active: true,
		},
	}}
	service := newSCIMTestService(t, repository)
	_, err := service.ReplaceUser(context.Background(), Authorization{OrganizationID: "org-1"}, "membership-1", ReplaceUserInput{
		UserInput: UserInput{
			ExternalID: "workday-42", UserName: "alice.employee", Email: "alice@example.com",
			DisplayName: "Alice", Active: false,
		},
	})
	if err != nil {
		t.Fatalf("replace SCIM user: %v", err)
	}
	if !repository.replacedUser.User.Active {
		t.Fatal("SCIM deprovisioning disabled the account-wide user")
	}
	if repository.replacedUser.Membership.Active {
		t.Fatal("SCIM deprovisioning did not disable the organization membership")
	}
}

func TestReplaceGroupExpressesOnlySCIMOwnedDesiredMemberships(t *testing.T) {
	repository := &scimRepositoryStub{group: GroupResource{Group: domain.Group{
		ID: "group-1", OrganizationID: "org-1", Source: domain.SourceSCIM, Active: true,
	}}}
	service := newSCIMTestService(t, repository)
	result, err := service.ReplaceGroup(context.Background(), Authorization{OrganizationID: "org-1"}, "group-1", ReplaceGroupInput{
		GroupInput: GroupInput{
			ExternalID: "group-ext", DisplayName: "Engineering",
			MemberIDs: []string{"membership-2", "membership-1", "membership-2"},
		},
	})
	if err != nil {
		t.Fatalf("replace group: %v", err)
	}
	if len(repository.replacedGroup.MemberIDs) != 2 || repository.replacedGroup.MemberIDs[0] != "membership-1" ||
		repository.replacedGroup.MemberIDs[1] != "membership-2" {
		t.Fatalf("replacement command = %#v", repository.replacedGroup)
	}
	if result.Group.ID != "group-1" {
		t.Fatalf("result = %#v", result)
	}
}

func TestDeleteGroupRemovesTheSCIMResourceInsteadOfInventingAnActiveField(t *testing.T) {
	repository := &scimRepositoryStub{}
	service := newSCIMTestService(t, repository)
	authorization := Authorization{TokenID: "scim-token-1", OrganizationID: "org-1"}

	if err := service.DeleteGroup(context.Background(), authorization, "group-1"); err != nil {
		t.Fatal(err)
	}
	if repository.deletedGroup.GroupID != "group-1" ||
		repository.deletedGroup.ActorTokenID != "scim-token-1" {
		t.Fatalf("delete command = %#v", repository.deletedGroup)
	}
}

func TestDeleteUserTombstonesOnlyTheSCIMResource(t *testing.T) {
	repository := &scimRepositoryStub{}
	service := newSCIMTestService(t, repository)
	authorization := Authorization{TokenID: "scim-token-1", OrganizationID: "org-1"}

	if err := service.DeleteUser(context.Background(), authorization, "membership-1"); err != nil {
		t.Fatal(err)
	}
	if repository.deletedUser.MembershipID != "membership-1" ||
		repository.deletedUser.ActorTokenID != "scim-token-1" {
		t.Fatalf("delete command = %#v", repository.deletedUser)
	}
}

func TestCreateGroupRejectsAnEmptyMemberReference(t *testing.T) {
	repository := &scimRepositoryStub{}
	service := newSCIMTestService(t, repository)

	_, err := service.CreateGroup(context.Background(), Authorization{
		TokenID: "scim-token-1", OrganizationID: "org-1",
	}, GroupInput{
		DisplayName: "Engineering", MemberIDs: []string{"membership-1", " "},
	})
	if !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatalf("create group error = %v, want invalid argument", err)
	}
}

type scimRepositoryStub struct {
	principal       domain.Principal
	issued          IssueTokenCommand
	authorization   Authorization
	resolvedHash    string
	user            UserResource
	group           GroupResource
	replacedUser    ReplaceUserCommand
	createdUser     CreateUserCommand
	replacedGroup   ReplaceGroupCommand
	listedUsers     ListQuery
	deletedUser     DeleteUserCommand
	deletedGroup    DeleteGroupCommand
	tokens          []Token
	listTokensCalls int
}

func (r *scimRepositoryStub) GetPrincipal(context.Context, string, string) (domain.Principal, error) {
	return r.principal, nil
}

func (r *scimRepositoryStub) IssueToken(_ context.Context, command IssueTokenCommand) (Token, error) {
	r.issued = command
	return Token{ID: command.TokenID, OrganizationID: command.OrganizationID, Name: command.Name, Scopes: command.Scopes}, nil
}

func (r *scimRepositoryStub) RevokeToken(context.Context, string, string, time.Time) error {
	return nil
}

func (r *scimRepositoryStub) ListTokens(context.Context, string) ([]Token, error) {
	r.listTokensCalls++
	return r.tokens, nil
}

func (r *scimRepositoryStub) ResolveToken(_ context.Context, digest string, _ time.Time) (Authorization, error) {
	r.resolvedHash = digest
	return r.authorization, nil
}

func (r *scimRepositoryStub) CreateUser(_ context.Context, command CreateUserCommand) (UserResource, error) {
	r.createdUser = command
	return UserResource{User: command.User, Membership: command.Membership}, nil
}

func (r *scimRepositoryStub) GetUser(context.Context, string, string) (UserResource, error) {
	return r.user, nil
}

func (r *scimRepositoryStub) ListUsers(_ context.Context, query ListQuery) (UserPage, error) {
	r.listedUsers = query
	return UserPage{}, nil
}

func (r *scimRepositoryStub) ReplaceUser(_ context.Context, command ReplaceUserCommand) (UserResource, error) {
	r.replacedUser = command
	return UserResource{User: command.User, Membership: command.Membership}, nil
}

func (r *scimRepositoryStub) DeleteUser(_ context.Context, command DeleteUserCommand) error {
	r.deletedUser = command
	return nil
}

func (r *scimRepositoryStub) CreateGroup(_ context.Context, command CreateGroupCommand) (GroupResource, error) {
	return GroupResource{Group: command.Group, MemberIDs: command.MemberIDs}, nil
}

func (r *scimRepositoryStub) GetGroup(context.Context, string, string) (GroupResource, error) {
	return r.group, nil
}

func (r *scimRepositoryStub) ListGroups(context.Context, ListQuery) (GroupPage, error) {
	return GroupPage{}, nil
}

func (r *scimRepositoryStub) ReplaceGroup(_ context.Context, command ReplaceGroupCommand) (GroupResource, error) {
	r.replacedGroup = command
	return GroupResource{Group: command.Group, MemberIDs: command.MemberIDs}, nil
}

func (r *scimRepositoryStub) DeleteGroup(_ context.Context, command DeleteGroupCommand) error {
	r.deletedGroup = command
	return nil
}

func newSCIMTestService(t *testing.T, repository *scimRepositoryStub) *Service {
	t.Helper()
	next := 0
	service, err := NewService(Config{
		Repository: repository,
		NewID:      func(kind string) string { next++; return fmt.Sprintf("%s-%d", kind, next) },
		NewOpaque: func(prefix string) (string, string, error) {
			raw := prefix + "secret"
			return raw, credentials.HashToken(raw), nil
		},
		Now: fixedSCIMNow,
	})
	if err != nil {
		t.Fatalf("new SCIM service: %v", err)
	}
	return service
}

func scimAdmin() domain.Principal {
	return domain.Principal{
		UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-admin",
		OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}
}

func fixedSCIMNow() time.Time { return time.Date(2026, 8, 31, 3, 0, 0, 0, time.UTC) }
