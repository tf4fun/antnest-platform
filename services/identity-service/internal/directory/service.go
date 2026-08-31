package directory

import (
	"context"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	GetPrincipal(context.Context, string, string) (domain.Principal, error)
	CreateOrganization(context.Context, CreateOrganizationCommand) (domain.Organization, error)
	CreateLocalUser(context.Context, CreateLocalUserCommand) (CreateLocalUserResult, error)
	AddOrganizationMembership(context.Context, AddOrganizationMembershipCommand) (domain.OrganizationMembership, error)
	ListDirectory(context.Context, string) (Directory, error)
}

type CreateOrganizationInput struct {
	RequestID        string
	ActorPrincipalID string
	Slug             string
	Name             string
}

type CreateOrganizationCommand struct {
	RequestID        string
	ActorPrincipalID string
	Organization     domain.Organization
	Membership       domain.OrganizationMembership
}

type CreateLocalUserInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	Email            string
	DisplayName      string
	Password         string
	Role             domain.OrganizationRole
}

type CreateLocalUserCommand struct {
	RequestID        string
	ActorPrincipalID string
	User             domain.User
	Membership       domain.OrganizationMembership
	PasswordHash     string
}

type CreateLocalUserResult struct {
	User       domain.User                   `json:"user"`
	Membership domain.OrganizationMembership `json:"membership"`
}

type AddOrganizationMembershipInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	UserID           string
	Role             domain.OrganizationRole
}

type AddOrganizationMembershipCommand struct {
	RequestID        string
	ActorPrincipalID string
	Membership       domain.OrganizationMembership
}

type Member struct {
	User       domain.User                   `json:"user"`
	Membership domain.OrganizationMembership `json:"membership"`
}

type Directory struct {
	Users  []Member       `json:"users"`
	Groups []domain.Group `json:"groups"`
}

type Service struct {
	repository Repository
	newID      func() string
	now        func() time.Time
}

func NewService(repository Repository, newID func() string, now func() time.Time) *Service {
	if repository == nil || newID == nil || now == nil {
		panic("directory service requires repository, id generator, and clock")
	}
	return &Service{repository: repository, newID: newID, now: now}
}

func (s *Service) CreateOrganization(
	ctx context.Context,
	input CreateOrganizationInput,
) (domain.Organization, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, "")
	if err != nil {
		return domain.Organization{}, fmt.Errorf("resolve organization actor: %w", err)
	}
	if !principal.Active || principal.SystemRole != domain.SystemRoleAdmin {
		return domain.Organization{}, domain.ErrForbidden
	}

	slug, err := domain.NormalizeSlug(input.Slug)
	if err != nil {
		return domain.Organization{}, err
	}
	name, err := domain.NormalizeDisplayName(input.Name)
	if err != nil {
		return domain.Organization{}, err
	}
	now := s.now().UTC()
	organization := domain.Organization{
		ID: s.newID(), Slug: slug, Name: name, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: organization.ID, UserID: principal.UserID,
		Role: domain.OrganizationRoleAdmin, Source: domain.SourceLocal, Active: true,
		CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.CreateOrganization(ctx, CreateOrganizationCommand{
		RequestID:        input.RequestID,
		ActorPrincipalID: input.ActorPrincipalID,
		Organization:     organization,
		Membership:       membership,
	})
}

func (s *Service) CreateLocalUser(
	ctx context.Context,
	input CreateLocalUserInput,
) (CreateLocalUserResult, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return CreateLocalUserResult{}, fmt.Errorf("resolve local-user actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return CreateLocalUserResult{}, domain.ErrForbidden
	}
	if input.Role != domain.OrganizationRoleAdmin && input.Role != domain.OrganizationRoleMember {
		return CreateLocalUserResult{}, domain.InvalidArgument("organization role is invalid")
	}

	email, err := domain.NormalizeEmail(input.Email)
	if err != nil {
		return CreateLocalUserResult{}, err
	}
	displayName, err := domain.NormalizeDisplayName(input.DisplayName)
	if err != nil {
		return CreateLocalUserResult{}, err
	}
	passwordHash, err := credentials.HashPassword(input.Password)
	if err != nil {
		return CreateLocalUserResult{}, domain.InvalidArgument(err.Error())
	}

	now := s.now().UTC()
	user := domain.User{
		ID: s.newID(), Email: email, DisplayName: displayName, SystemRole: domain.SystemRoleUser,
		Source: domain.SourceLocal, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: input.OrganizationID, UserID: user.ID, Role: input.Role,
		Source: domain.SourceLocal, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.CreateLocalUser(ctx, CreateLocalUserCommand{
		RequestID:        input.RequestID,
		ActorPrincipalID: input.ActorPrincipalID,
		User:             user,
		Membership:       membership,
		PasswordHash:     passwordHash,
	})
}

func (s *Service) AddOrganizationMembership(
	ctx context.Context,
	input AddOrganizationMembershipInput,
) (domain.OrganizationMembership, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return domain.OrganizationMembership{}, fmt.Errorf("resolve membership actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return domain.OrganizationMembership{}, domain.ErrForbidden
	}
	if input.Role != domain.OrganizationRoleAdmin && input.Role != domain.OrganizationRoleMember {
		return domain.OrganizationMembership{}, domain.InvalidArgument("organization role is invalid")
	}
	userID := strings.TrimSpace(input.UserID)
	if userID == "" {
		return domain.OrganizationMembership{}, domain.InvalidArgument("user ID is required")
	}
	now := s.now().UTC()
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: input.OrganizationID, UserID: userID,
		Role: input.Role, Source: domain.SourceLocal, Active: true,
		CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.AddOrganizationMembership(ctx, AddOrganizationMembershipCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID, Membership: membership,
	})
}

func (s *Service) List(ctx context.Context, actorPrincipalID, organizationID string) (Directory, error) {
	principal, err := s.repository.GetPrincipal(ctx, actorPrincipalID, organizationID)
	if err != nil {
		return Directory{}, fmt.Errorf("resolve directory actor: %w", err)
	}
	if !principal.CanAdminister(organizationID) {
		return Directory{}, domain.ErrForbidden
	}
	return s.repository.ListDirectory(ctx, organizationID)
}
