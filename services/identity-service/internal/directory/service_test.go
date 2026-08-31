package directory

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

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
		repository.createdOrganization.Membership.Role != domain.OrganizationRoleAdmin {
		t.Fatalf("creator membership = %#v", repository.createdOrganization.Membership)
	}

	repository.principal = domain.Principal{UserID: "member", SystemRole: domain.SystemRoleUser, Active: true}
	_, err = service.CreateOrganization(context.Background(), CreateOrganizationInput{
		ActorPrincipalID: "member", Slug: "other", Name: "Other",
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
	if result.User.Email != "alice@example.com" || result.User.Source != domain.SourceLocal ||
		result.Membership.OrganizationID != "org-1" || result.Membership.Source != domain.SourceLocal {
		t.Fatalf("result = %#v", result)
	}
	if repository.created.PasswordHash == "" || repository.created.PasswordHash == "correct horse battery staple" {
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

func TestAddOrganizationMembershipUsesStableUserIdentity(t *testing.T) {
	t.Parallel()
	repository := &directoryRepositoryStub{principal: domain.Principal{
		UserID: "admin", OrganizationID: "org-2", OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}}
	service := NewService(repository, sequentialIDs(), fixedNow)

	membership, err := service.AddOrganizationMembership(context.Background(), AddOrganizationMembershipInput{
		RequestID: "membership-request", ActorPrincipalID: "admin",
		OrganizationID: "org-2", UserID: "user-1", Role: domain.OrganizationRoleMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	if membership.UserID != "user-1" || membership.OrganizationID != "org-2" ||
		membership.Source != domain.SourceLocal || repository.addedMembership.RequestID != "membership-request" {
		t.Fatalf("membership=%#v command=%#v", membership, repository.addedMembership)
	}
}

type directoryRepositoryStub struct {
	principal           domain.Principal
	createdOrganization CreateOrganizationCommand
	created             CreateLocalUserCommand
	addedMembership     AddOrganizationMembershipCommand
	directory           Directory
}

func (r *directoryRepositoryStub) GetPrincipal(context.Context, string, string) (domain.Principal, error) {
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

func sequentialIDs() func() string {
	next := 0
	return func() string {
		next++
		return fmt.Sprintf("id-%d", next)
	}
}

func fixedNow() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) }
