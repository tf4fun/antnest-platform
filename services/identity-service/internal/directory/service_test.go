package directory

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestCreateOrganizationRequiresSystemAdministrator(t *testing.T) {
	t.Parallel()

	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "root", SystemRole: domain.SystemRoleAdmin, Active: true,
	}}
	service := NewService(repository, sequentialIDs(), fixedNow)
	organization, err := service.CreateOrganization(context.Background(), CreateOrganizationInput{
		RequestID: "request-organization", ActorPrincipalID: "root",
		Slug: " Engineering ", Name: " Engineering Team ",
		OwnerEmail: "root@example.com", OwnerDisplayName: "Root Administrator",
	})
	if err != nil {
		t.Fatalf("create organization: %v", err)
	}
	if organization.ID != "id-1" || organization.Slug != "engineering" || organization.Name != "Engineering Team" {
		t.Fatalf("organization = %#v", organization)
	}
	if repository.createdOrganization.RequestID != "request-organization" {
		t.Fatalf("organization command = %#v", repository.createdOrganization)
	}
	if repository.createdOrganization.Membership.UserID != "root" ||
		repository.createdOrganization.Membership.OrganizationID != organization.ID ||
		repository.createdOrganization.Membership.Email != "root@example.com" ||
		repository.createdOrganization.Membership.Role != domain.OrganizationRoleAdmin {
		t.Fatalf("creator membership = %#v", repository.createdOrganization.Membership)
	}

	repository.principal = domain.Principal{UserID: "member", SystemRole: domain.SystemRoleUser, Active: true}
	_, err = service.CreateOrganization(context.Background(), CreateOrganizationInput{
		ActorPrincipalID: "member", Slug: "other", Name: "Other",
		OwnerEmail: "member@example.com", OwnerDisplayName: "Member",
	})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-system create error = %v, want forbidden", err)
	}
}

func TestCreateLocalUserNormalizesAndHashesPassword(t *testing.T) {
	t.Parallel()

	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "admin", OrganizationID: "org-1", OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}}
	service := NewService(repository, sequentialIDs(), fixedNow)
	result, err := service.CreateLocalUser(context.Background(), CreateLocalUserInput{
		RequestID: "request-user", ActorPrincipalID: "admin",
		OrganizationID: "org-1", Email: " Alice@Example.COM ",
		DisplayName: " Alice ", Password: "correct horse battery staple", Role: domain.OrganizationRoleMember,
	})
	if err != nil {
		t.Fatalf("create local user: %v", err)
	}
	if result.User.SystemRole != domain.SystemRoleUser ||
		result.Membership.Email != "alice@example.com" || result.Membership.DisplayName != "Alice" ||
		result.Membership.OrganizationID != "org-1" || result.Membership.Source != domain.SourceLocal {
		t.Fatalf("result = %#v", result)
	}
	if repository.created.Credential.PasswordHash == "" ||
		repository.created.Credential.PasswordHash == "correct horse battery staple" ||
		repository.created.Credential.UserID != result.User.ID {
		t.Fatal("repository did not receive a password hash")
	}
	if repository.created.RequestID != "request-user" {
		t.Fatalf("local-user command = %#v", repository.created)
	}
	if result.User.ID == result.Membership.ID {
		t.Fatal("user and organization membership reused identity")
	}
}

func TestListDirectoryIsOrganizationScoped(t *testing.T) {
	t.Parallel()

	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "admin", OrganizationID: "org-1", OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}, directory: Directory{Users: []Member{{User: domain.User{ID: "user-1"}}}}}
	service := NewService(repository, sequentialIDs(), fixedNow)
	result, err := service.List(context.Background(), "admin", "org-1")
	if err != nil || len(result.Users) != 1 {
		t.Fatalf("list directory = %#v, %v", result, err)
	}
	_, err = service.List(context.Background(), "admin", "org-2")
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("cross-organization list error = %v, want forbidden", err)
	}
}

func TestGetCurrentAccountProjectsTheActorAndLocalPasswordCapability(t *testing.T) {
	repository := &directoryRepositoryStub{
		organization: domain.Organization{
			ID: "org-1", Slug: "engineering", Name: "Engineering", Active: true,
		},
		principal: domain.Principal{
			UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleAdmin,
			Active: true,
		},
		membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
			Email: "alice@example.com", DisplayName: "Alice",
			Role: domain.OrganizationRoleAdmin, Source: domain.SourceLocal, Active: true,
		},
		credential: domain.LocalCredential{UserID: "user-1", PasswordHash: "opaque"},
	}
	service := NewService(repository, sequentialIDs(), fixedNow)

	account, err := service.GetCurrentAccount(context.Background(), "user-1", "org-1")
	if err != nil {
		t.Fatalf("get current account: %v", err)
	}
	if account.UserID != "user-1" || account.OrganizationID != "org-1" ||
		account.OrganizationSlug != "engineering" || account.OrganizationName != "Engineering" ||
		account.MembershipID != "membership-1" || account.Email != "alice@example.com" ||
		account.DisplayName != "Alice" || account.Source != domain.SourceLocal ||
		!account.LocalPasswordAvailable {
		t.Fatalf("account = %#v", account)
	}

	repository.credentialErr = domain.ErrNotFound
	account, err = service.GetCurrentAccount(context.Background(), "user-1", "org-1")
	if err != nil {
		t.Fatalf("get external account: %v", err)
	}
	if account.LocalPasswordAvailable {
		t.Fatalf("external account unexpectedly exposes local password capability: %#v", account)
	}
}

func TestGetCurrentAccountRejectsInactiveOrMismatchedIdentity(t *testing.T) {
	repository := &directoryRepositoryStub{
		organization: domain.Organization{
			ID: "org-1", Slug: "engineering", Name: "Engineering", Active: true,
		},
		principal: domain.Principal{
			UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			Active: false,
		},
		membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
		},
	}
	service := NewService(repository, sequentialIDs(), fixedNow)
	if _, err := service.GetCurrentAccount(context.Background(), "user-1", "org-1"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("inactive account error = %v, want forbidden", err)
	}

	repository.principal.Active = true
	repository.membership.UserID = "user-2"
	if _, err := service.GetCurrentAccount(context.Background(), "user-1", "org-1"); err == nil {
		t.Fatal("mismatched membership was accepted")
	}
}

func TestGetCurrentAccountRejectsMismatchedOrganizationProjection(t *testing.T) {
	repository := &directoryRepositoryStub{
		organization: domain.Organization{
			ID: "org-2", Slug: "other", Name: "Other", Active: true,
		},
		principal: domain.Principal{
			UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			Active: true,
		},
		membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
		},
		credential: domain.LocalCredential{UserID: "user-1"},
	}
	service := NewService(repository, sequentialIDs(), fixedNow)

	if _, err := service.GetCurrentAccount(context.Background(), "user-1", "org-1"); err == nil {
		t.Fatal("mismatched organization projection was accepted")
	}
}

func TestResolvePrincipalReturnsOnlyTheRequestedOrganizationBinding(t *testing.T) {
	t.Parallel()

	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
		SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleMember,
		Active: true,
	}}
	service := NewService(repository, sequentialIDs(), fixedNow)

	principal, err := service.ResolvePrincipal(context.Background(), "user-1", "org-1")
	if err != nil {
		t.Fatalf("resolve principal: %v", err)
	}
	if principal != repository.principal || repository.principalUserID != "user-1" ||
		repository.principalOrganizationID != "org-1" {
		t.Fatalf("principal=%#v query=%q/%q", principal, repository.principalUserID, repository.principalOrganizationID)
	}
	if _, err := service.ResolvePrincipal(context.Background(), " user-1 ", "org-1"); !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatalf("whitespace user ID error = %v, want invalid argument", err)
	}

	if _, err := service.ResolvePrincipal(context.Background(), "", "org-1"); !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatalf("empty user error = %v, want invalid argument", err)
	}
	repository.principal.MembershipID = ""
	if _, err := service.ResolvePrincipal(context.Background(), "user-1", "org-1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing membership error = %v, want not found", err)
	}
}

func TestAddOrganizationMembershipUsesStableUserIdentity(t *testing.T) {
	t.Parallel()
	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "admin", OrganizationID: "org-2", OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}}
	service := NewService(repository, sequentialIDs(), fixedNow)

	membership, err := service.AddOrganizationMembership(context.Background(), AddOrganizationMembershipInput{
		RequestID: "membership-request", ActorPrincipalID: "admin",
		OrganizationID: "org-2", UserID: "user-1", Role: domain.OrganizationRoleMember,
		Email: " Alice@Example.COM ", DisplayName: " Alice ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if membership.UserID != "user-1" || membership.OrganizationID != "org-2" ||
		membership.Email != "alice@example.com" || membership.DisplayName != "Alice" ||
		membership.Source != domain.SourceLocal || repository.addedMembership.RequestID != "membership-request" {
		t.Fatalf("membership=%#v command=%#v", membership, repository.addedMembership)
	}
}

func TestChangeLocalPasswordRequiresTheCurrentCredential(t *testing.T) {
	currentHash, err := credentials.HashPassword("current correct password")
	if err != nil {
		t.Fatal(err)
	}
	repository := &directoryRepositoryStub{
		principal:  domain.Principal{UserID: "user-1", Active: true},
		credential: domain.LocalCredential{UserID: "user-1", PasswordHash: currentHash},
	}
	service := NewService(repository, sequentialIDs(), fixedNow)

	err = service.ChangeLocalPassword(context.Background(), ChangeLocalPasswordInput{
		RequestID: "password-change", ActorPrincipalID: "user-1", UserID: "user-1",
		CurrentPassword: "current correct password", NewPassword: "replacement correct password",
	})
	if err != nil {
		t.Fatalf("change local password: %v", err)
	}
	if repository.changedPassword.ExpectedPasswordHash != currentHash ||
		repository.changedPassword.PasswordHash == currentHash ||
		repository.changedPassword.PasswordHash == "replacement correct password" {
		t.Fatalf("password command = %#v", repository.changedPassword)
	}

	err = service.ChangeLocalPassword(context.Background(), ChangeLocalPasswordInput{
		ActorPrincipalID: "user-1", UserID: "user-1",
		CurrentPassword: "wrong password", NewPassword: "another replacement password",
	})
	if !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("wrong current password error = %v", err)
	}
}

func TestUpdateLocalMembershipAndGlobalUserActivationRespectOwnership(t *testing.T) {
	repository := &directoryRepositoryStub{
		principal: domain.Principal{
			UserID: "admin", OrganizationID: "org-1", OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
		},
		membership: domain.OrganizationMembership{
			ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
			Email: "alice@example.com", DisplayName: "Alice", Role: domain.OrganizationRoleMember,
			Source: domain.SourceLocal, Active: true,
		},
	}
	service := NewService(repository, sequentialIDs(), fixedNow)

	updated, err := service.UpdateMembership(context.Background(), UpdateMembershipInput{
		RequestID: "membership-update", ActorPrincipalID: "admin", OrganizationID: "org-1",
		MembershipID: "membership-1", Email: "Alice.Updated@Example.com",
		DisplayName: "Alice Updated", Role: domain.OrganizationRoleAdmin, Active: false,
	})
	if err != nil {
		t.Fatalf("update membership: %v", err)
	}
	if updated.Email != "alice.updated@example.com" || updated.Active ||
		repository.updatedMembership.ExpectedUpdatedAt != repository.membership.UpdatedAt {
		t.Fatalf("updated=%#v command=%#v", updated, repository.updatedMembership)
	}

	repository.principal = domain.Principal{UserID: "root", SystemRole: domain.SystemRoleAdmin, Active: true}
	if err := service.SetUserActive(context.Background(), SetUserActiveInput{
		RequestID: "disable-user", ActorPrincipalID: "root", UserID: "user-1", Active: false,
	}); err != nil {
		t.Fatalf("disable user: %v", err)
	}
	if repository.userActivation.UserID != "user-1" || repository.userActivation.Active {
		t.Fatalf("activation command = %#v", repository.userActivation)
	}

	err = service.SetUserActive(context.Background(), SetUserActiveInput{
		ActorPrincipalID: "root", UserID: "root", Active: false,
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("system administrator self-disable error = %v, want conflict", err)
	}
}

type directoryRepositoryStub struct {
	organization            domain.Organization
	principal               domain.Principal
	principalUserID         string
	principalOrganizationID string
	createdOrganization     CreateOrganizationCommand
	created                 CreateLocalUserCommand
	addedMembership         AddOrganizationMembershipCommand
	credential              domain.LocalCredential
	credentialErr           error
	membership              domain.OrganizationMembership
	changedPassword         ChangeLocalPasswordCommand
	updatedMembership       UpdateMembershipCommand
	userActivation          SetUserActiveCommand
	directory               Directory
}

func (r *directoryRepositoryStub) GetOrganization(context.Context, string) (domain.Organization, error) {
	return r.organization, nil
}

func (r *directoryRepositoryStub) GetPrincipal(_ context.Context, userID, organizationID string) (domain.Principal, error) {
	r.principalUserID = userID
	r.principalOrganizationID = organizationID
	return r.principal, nil
}

func (r *directoryRepositoryStub) ResolveOrganizationPrincipal(
	_ context.Context,
	userID string,
	organizationID string,
) (domain.Principal, error) {
	r.principalUserID = userID
	r.principalOrganizationID = organizationID
	return r.principal, nil
}

func (r *directoryRepositoryStub) CreateOrganization(_ context.Context, command CreateOrganizationCommand) (domain.Organization, error) {
	r.createdOrganization = command
	return command.Organization, nil
}

func (r *directoryRepositoryStub) CreateLocalUser(_ context.Context, command CreateLocalUserCommand) (CreateLocalUserResult, error) {
	r.created = command
	return CreateLocalUserResult{User: command.User, Membership: command.Membership}, nil
}

func (r *directoryRepositoryStub) AddOrganizationMembership(
	_ context.Context,
	command AddOrganizationMembershipCommand,
) (domain.OrganizationMembership, error) {
	r.addedMembership = command
	return command.Membership, nil
}

func (r *directoryRepositoryStub) ListDirectory(context.Context, string) (Directory, error) {
	return r.directory, nil
}

func (r *directoryRepositoryStub) GetLocalCredential(context.Context, string) (domain.LocalCredential, error) {
	return r.credential, r.credentialErr
}

func (r *directoryRepositoryStub) ChangeLocalPassword(_ context.Context, command ChangeLocalPasswordCommand) error {
	r.changedPassword = command
	return nil
}

func (r *directoryRepositoryStub) GetMembership(context.Context, string, string) (domain.OrganizationMembership, error) {
	return r.membership, nil
}

func (r *directoryRepositoryStub) UpdateMembership(
	_ context.Context,
	command UpdateMembershipCommand,
) (domain.OrganizationMembership, error) {
	r.updatedMembership = command
	return command.Membership, nil
}

func (r *directoryRepositoryStub) SetUserActive(_ context.Context, command SetUserActiveCommand) error {
	r.userActivation = command
	return nil
}

func sequentialIDs() func() string {
	next := 0
	return func() string {
		next++
		return fmt.Sprintf("id-%d", next)
	}
}

func fixedNow() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) }
