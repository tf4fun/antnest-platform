package directory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	ListPrincipalRevocations(context.Context, RevocationQuery) (domain.PrincipalRevocationPage, error)
	GetOrganization(context.Context, string) (domain.Organization, error)
	GetPrincipal(context.Context, string, string) (domain.Principal, error)
	ResolveOrganizationPrincipal(context.Context, string, string) (domain.Principal, error)
	CreateOrganization(context.Context, CreateOrganizationCommand) (domain.Organization, error)
	CreateLocalUser(context.Context, CreateLocalUserCommand) (CreateLocalUserResult, error)
	AddOrganizationMembership(context.Context, AddOrganizationMembershipCommand) (domain.OrganizationMembership, error)
	GetLocalCredential(context.Context, string) (domain.LocalCredential, error)
	ChangeLocalPassword(context.Context, ChangeLocalPasswordCommand) error
	GetMembership(context.Context, string, string) (domain.OrganizationMembership, error)
	UpdateMembership(context.Context, UpdateMembershipCommand) (domain.OrganizationMembership, error)
	SetUserActive(context.Context, SetUserActiveCommand) error
	ListDirectory(context.Context, string) (Directory, error)
}

type CreateOrganizationInput struct {
	RequestID        string
	ActorPrincipalID string
	Slug             string
	Name             string
	OwnerEmail       string
	OwnerDisplayName string
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
	Credential       domain.LocalCredential
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
	Email            string
	DisplayName      string
	Role             domain.OrganizationRole
}

type AddOrganizationMembershipCommand struct {
	RequestID        string
	ActorPrincipalID string
	Membership       domain.OrganizationMembership
}

type ChangeLocalPasswordInput struct {
	RequestID        string
	ActorPrincipalID string
	UserID           string
	CurrentPassword  string
	NewPassword      string
}

type ChangeLocalPasswordCommand struct {
	RequestID            string
	ActorPrincipalID     string
	UserID               string
	ExpectedPasswordHash string
	PasswordHash         string
	UpdatedAt            time.Time
}

type UpdateMembershipInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	MembershipID     string
	Email            string
	DisplayName      string
	Role             domain.OrganizationRole
	Active           bool
}

type UpdateMembershipCommand struct {
	RequestID         string
	ActorPrincipalID  string
	Membership        domain.OrganizationMembership
	ExpectedUpdatedAt time.Time
}

type SetUserActiveInput struct {
	RequestID        string
	ActorPrincipalID string
	UserID           string
	Active           bool
}

type SetUserActiveCommand struct {
	RequestID        string
	ActorPrincipalID string
	UserID           string
	Active           bool
	UpdatedAt        time.Time
}

type Member struct {
	User       domain.User                   `json:"user"`
	Membership domain.OrganizationMembership `json:"membership"`
}

type Directory struct {
	Users  []Member       `json:"users"`
	Groups []domain.Group `json:"groups"`
}

type CurrentAccount struct {
	UserID                 string        `json:"user_id"`
	OrganizationID         string        `json:"organization_id"`
	OrganizationSlug       string        `json:"organization_slug"`
	OrganizationName       string        `json:"organization_name"`
	MembershipID           string        `json:"membership_id"`
	Email                  string        `json:"email"`
	DisplayName            string        `json:"display_name"`
	Source                 domain.Source `json:"source"`
	LocalPasswordAvailable bool          `json:"local_password_available"`
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
	ownerEmail, err := domain.NormalizeEmail(input.OwnerEmail)
	if err != nil {
		return domain.Organization{}, fmt.Errorf("organization owner: %w", err)
	}
	ownerDisplayName, err := domain.NormalizeDisplayName(input.OwnerDisplayName)
	if err != nil {
		return domain.Organization{}, fmt.Errorf("organization owner: %w", err)
	}
	now := s.now().UTC()
	organization := domain.Organization{
		ID: s.newID(), Slug: slug, Name: name, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: organization.ID, UserID: principal.UserID,
		Email: ownerEmail, DisplayName: ownerDisplayName,
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
		ID: s.newID(), SystemRole: domain.SystemRoleUser,
		Active: true, CreatedAt: now, UpdatedAt: now,
	}
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: input.OrganizationID, UserID: user.ID, Role: input.Role,
		Email: email, DisplayName: displayName,
		Source: domain.SourceLocal, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.CreateLocalUser(ctx, CreateLocalUserCommand{
		RequestID:        input.RequestID,
		ActorPrincipalID: input.ActorPrincipalID,
		User:             user,
		Membership:       membership,
		Credential: domain.LocalCredential{
			UserID: user.ID, PasswordHash: passwordHash, CreatedAt: now, UpdatedAt: now,
		},
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
	email, err := domain.NormalizeEmail(input.Email)
	if err != nil {
		return domain.OrganizationMembership{}, err
	}
	displayName, err := domain.NormalizeDisplayName(input.DisplayName)
	if err != nil {
		return domain.OrganizationMembership{}, err
	}
	now := s.now().UTC()
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: input.OrganizationID, UserID: userID,
		Email: email, DisplayName: displayName,
		Role: input.Role, Source: domain.SourceLocal, Active: true,
		CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.AddOrganizationMembership(ctx, AddOrganizationMembershipCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID, Membership: membership,
	})
}

func (s *Service) ChangeLocalPassword(ctx context.Context, input ChangeLocalPasswordInput) error {
	actorID := strings.TrimSpace(input.ActorPrincipalID)
	userID := strings.TrimSpace(input.UserID)
	if actorID == "" || userID == "" {
		return domain.InvalidArgument("actor principal ID and user ID are required")
	}
	principal, err := s.repository.GetPrincipal(ctx, actorID, "")
	if err != nil {
		return fmt.Errorf("resolve password actor: %w", err)
	}
	if !principal.Active || principal.UserID != userID {
		return domain.ErrForbidden
	}
	credential, err := s.repository.GetLocalCredential(ctx, userID)
	if err != nil {
		return fmt.Errorf("load local credential: %w", err)
	}
	valid, err := credentials.VerifyPassword(credential.PasswordHash, input.CurrentPassword)
	if err != nil {
		return fmt.Errorf("verify current password: %w", err)
	}
	if !valid {
		return domain.ErrUnauthenticated
	}
	passwordHash, err := credentials.HashPassword(input.NewPassword)
	if err != nil {
		return domain.InvalidArgument(err.Error())
	}
	return s.repository.ChangeLocalPassword(ctx, ChangeLocalPasswordCommand{
		RequestID: input.RequestID, ActorPrincipalID: actorID, UserID: userID,
		ExpectedPasswordHash: credential.PasswordHash, PasswordHash: passwordHash,
		UpdatedAt: s.now().UTC(),
	})
}

func (s *Service) UpdateMembership(
	ctx context.Context,
	input UpdateMembershipInput,
) (domain.OrganizationMembership, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return domain.OrganizationMembership{}, fmt.Errorf("resolve membership actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return domain.OrganizationMembership{}, domain.ErrForbidden
	}
	membership, err := s.repository.GetMembership(ctx, input.OrganizationID, strings.TrimSpace(input.MembershipID))
	if err != nil {
		return domain.OrganizationMembership{}, err
	}
	if membership.Source != domain.SourceLocal {
		return domain.OrganizationMembership{}, domain.ErrConflict
	}
	if input.Role != domain.OrganizationRoleAdmin && input.Role != domain.OrganizationRoleMember {
		return domain.OrganizationMembership{}, domain.InvalidArgument("organization role is invalid")
	}
	email, err := domain.NormalizeEmail(input.Email)
	if err != nil {
		return domain.OrganizationMembership{}, err
	}
	displayName, err := domain.NormalizeDisplayName(input.DisplayName)
	if err != nil {
		return domain.OrganizationMembership{}, err
	}
	expectedUpdatedAt := membership.UpdatedAt
	membership.Email = email
	membership.DisplayName = displayName
	membership.Role = input.Role
	membership.Active = input.Active
	membership.UpdatedAt = domain.NextUpdatedAt(s.now(), expectedUpdatedAt)
	return s.repository.UpdateMembership(ctx, UpdateMembershipCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID,
		Membership: membership, ExpectedUpdatedAt: expectedUpdatedAt,
	})
}

func (s *Service) SetUserActive(ctx context.Context, input SetUserActiveInput) error {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, "")
	if err != nil {
		return fmt.Errorf("resolve user-lifecycle actor: %w", err)
	}
	if !principal.Active || principal.SystemRole != domain.SystemRoleAdmin {
		return domain.ErrForbidden
	}
	userID := strings.TrimSpace(input.UserID)
	if userID == "" {
		return domain.InvalidArgument("user ID is required")
	}
	if !input.Active && userID == principal.UserID {
		return domain.ErrConflict
	}
	return s.repository.SetUserActive(ctx, SetUserActiveCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID,
		UserID: userID, Active: input.Active, UpdatedAt: s.now().UTC(),
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

func (s *Service) GetCurrentAccount(
	ctx context.Context,
	actorPrincipalID string,
	organizationID string,
) (CurrentAccount, error) {
	if !domain.ValidID(actorPrincipalID) || !domain.ValidID(organizationID) {
		return CurrentAccount{}, domain.InvalidArgument(
			"actor principal ID and organization ID are invalid",
		)
	}
	principal, err := s.repository.GetPrincipal(ctx, actorPrincipalID, organizationID)
	if err != nil {
		return CurrentAccount{}, fmt.Errorf("resolve current account actor: %w", err)
	}
	if !principal.Active {
		return CurrentAccount{}, domain.ErrForbidden
	}
	if principal.UserID != actorPrincipalID || principal.OrganizationID != organizationID ||
		!domain.ValidID(principal.MembershipID) {
		return CurrentAccount{}, fmt.Errorf("current account principal binding is inconsistent")
	}
	organization, err := s.repository.GetOrganization(ctx, organizationID)
	if err != nil {
		return CurrentAccount{}, fmt.Errorf("load current account organization: %w", err)
	}
	if organization.ID != organizationID || strings.TrimSpace(organization.Slug) == "" ||
		strings.TrimSpace(organization.Name) == "" {
		return CurrentAccount{}, fmt.Errorf("current account organization binding is inconsistent")
	}
	if !organization.Active {
		return CurrentAccount{}, domain.ErrForbidden
	}
	membership, err := s.repository.GetMembership(ctx, organizationID, principal.MembershipID)
	if err != nil {
		return CurrentAccount{}, fmt.Errorf("load current account membership: %w", err)
	}
	if membership.UserID != principal.UserID || membership.OrganizationID != organizationID {
		return CurrentAccount{}, fmt.Errorf("current account membership binding is inconsistent")
	}

	_, err = s.repository.GetLocalCredential(ctx, principal.UserID)
	localPasswordAvailable := err == nil
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return CurrentAccount{}, fmt.Errorf("resolve current account password capability: %w", err)
	}
	return CurrentAccount{
		UserID: principal.UserID, OrganizationID: organizationID,
		OrganizationSlug: organization.Slug, OrganizationName: organization.Name,
		MembershipID: membership.ID, Email: membership.Email,
		DisplayName: membership.DisplayName, Source: membership.Source,
		LocalPasswordAvailable: localPasswordAvailable,
	}, nil
}

func (s *Service) ResolvePrincipal(
	ctx context.Context, userID string, organizationID string,
) (domain.Principal, error) {
	if !domain.ValidID(userID) || !domain.ValidID(organizationID) {
		return domain.Principal{}, domain.InvalidArgument(
			"user ID and organization ID are invalid",
		)
	}
	principal, err := s.repository.ResolveOrganizationPrincipal(ctx, userID, organizationID)
	if err != nil {
		return domain.Principal{}, fmt.Errorf("resolve organization principal: %w", err)
	}
	if principal.UserID != userID || principal.OrganizationID != organizationID {
		return domain.Principal{}, fmt.Errorf("resolve organization principal returned mismatched identity")
	}
	if strings.TrimSpace(principal.MembershipID) == "" {
		return domain.Principal{}, domain.ErrNotFound
	}
	return principal, nil
}
