package scim

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	GetPrincipal(context.Context, string, string) (domain.Principal, error)
	IssueToken(context.Context, IssueTokenCommand) (Token, error)
	RevokeToken(context.Context, string, string, time.Time) error
	ResolveToken(context.Context, string, time.Time) (Authorization, error)
	CreateUser(context.Context, CreateUserCommand) (UserResource, error)
	GetUser(context.Context, string, string) (UserResource, error)
	ListUsers(context.Context, ListQuery) (UserPage, error)
	ReplaceUser(context.Context, ReplaceUserCommand) (UserResource, error)
	CreateGroup(context.Context, CreateGroupCommand) (GroupResource, error)
	GetGroup(context.Context, string, string) (GroupResource, error)
	ListGroups(context.Context, ListQuery) (GroupPage, error)
	ReplaceGroup(context.Context, ReplaceGroupCommand) (GroupResource, error)
	DeleteGroup(context.Context, DeleteGroupCommand) error
}

type Token struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	Name           string    `json:"name"`
	Scopes         []string  `json:"scopes"`
	CreatedAt      time.Time `json:"created_at"`
	RevokedAt      time.Time `json:"revoked_at,omitempty"`
}

type Authorization struct {
	TokenID        string
	OrganizationID string
	Scopes         []string
}

type IssueTokenInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	Name             string
	Scopes           []string
}

type IssueTokenCommand struct {
	RequestID        string
	ActorPrincipalID string
	TokenID          string
	TokenHash        string
	OrganizationID   string
	Name             string
	Scopes           []string
	CreatedAt        time.Time
}

type IssueTokenResult struct {
	Token      Token  `json:"token"`
	Credential string `json:"credential"`
}

type UserInput struct {
	ExternalID  string
	UserName    string
	DisplayName string
	Active      bool
}

type UserResource struct {
	User       domain.User
	Membership domain.OrganizationMembership
}

type CreateUserCommand struct {
	OrganizationID string
	ActorTokenID   string
	User           domain.User
	Membership     domain.OrganizationMembership
}

type ReplaceUserCommand struct {
	OrganizationID string
	ActorTokenID   string
	User           domain.User
	Membership     domain.OrganizationMembership
}

type GroupInput struct {
	ExternalID  string
	DisplayName string
	MemberIDs   []string
}

type GroupResource struct {
	Group     domain.Group
	MemberIDs []string
}

type CreateGroupCommand struct {
	OrganizationID string
	ActorTokenID   string
	Group          domain.Group
	MemberIDs      []string
}

type ReplaceGroupCommand struct {
	OrganizationID string
	ActorTokenID   string
	Group          domain.Group
	MemberIDs      []string
}

type DeleteGroupCommand struct {
	OrganizationID string
	ActorTokenID   string
	GroupID        string
	DeletedAt      time.Time
}

type ListQuery struct {
	OrganizationID  string
	FilterAttribute string
	FilterValue     string
	StartIndex      int
	Count           int
}

type UserPage struct {
	Items        []UserResource
	TotalResults int
}

type GroupPage struct {
	Items        []GroupResource
	TotalResults int
}

type Config struct {
	Repository Repository
	NewID      func() string
	NewOpaque  func(string) (string, string, error)
	Now        func() time.Time
}

type Service struct {
	repository Repository
	newID      func() string
	newOpaque  func(string) (string, string, error)
	now        func() time.Time
}

func NewService(config Config) (*Service, error) {
	if config.Repository == nil || config.NewID == nil || config.NewOpaque == nil || config.Now == nil {
		return nil, fmt.Errorf("SCIM service requires repository, generators, and clock")
	}
	return &Service{
		repository: config.Repository,
		newID:      config.NewID,
		newOpaque:  config.NewOpaque,
		now:        config.Now,
	}, nil
}

func (s *Service) IssueToken(ctx context.Context, input IssueTokenInput) (IssueTokenResult, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return IssueTokenResult{}, fmt.Errorf("resolve SCIM token actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return IssueTokenResult{}, domain.ErrForbidden
	}
	name, err := domain.NormalizeDisplayName(input.Name)
	if err != nil {
		return IssueTokenResult{}, err
	}
	scopes, err := domain.NormalizeSCIMScopes(input.Scopes)
	if err != nil {
		return IssueTokenResult{}, err
	}
	raw, digest, err := s.newOpaque("ant_scim_")
	if err != nil {
		return IssueTokenResult{}, fmt.Errorf("generate SCIM credential: %w", err)
	}
	command := IssueTokenCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID,
		TokenID: s.newID(), TokenHash: digest, OrganizationID: input.OrganizationID,
		Name: name, Scopes: scopes, CreatedAt: s.now().UTC(),
	}
	token, err := s.repository.IssueToken(ctx, command)
	if err != nil {
		return IssueTokenResult{}, fmt.Errorf("issue SCIM token: %w", err)
	}
	return IssueTokenResult{Token: token, Credential: raw}, nil
}

func (s *Service) RevokeToken(ctx context.Context, actorPrincipalID, tokenID string) error {
	if strings.TrimSpace(tokenID) == "" {
		return domain.ErrNotFound
	}
	if err := s.repository.RevokeToken(ctx, actorPrincipalID, tokenID, s.now().UTC()); err != nil {
		return fmt.Errorf("revoke SCIM token: %w", err)
	}
	return nil
}

func (s *Service) Authorize(ctx context.Context, rawToken, requiredScope string) (Authorization, error) {
	if strings.TrimSpace(rawToken) == "" {
		return Authorization{}, domain.ErrUnauthenticated
	}
	authorization, err := s.repository.ResolveToken(ctx, credentials.HashToken(rawToken), s.now().UTC())
	if errors.Is(err, domain.ErrNotFound) {
		return Authorization{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return Authorization{}, fmt.Errorf("resolve SCIM token: %w", err)
	}
	if !containsScope(authorization.Scopes, requiredScope) {
		return Authorization{}, domain.ErrForbidden
	}
	return authorization, nil
}

func (s *Service) CreateUser(ctx context.Context, authorization Authorization, input UserInput) (UserResource, error) {
	email, displayName, err := normalizeUserInput(input)
	if err != nil {
		return UserResource{}, err
	}
	now := s.now().UTC()
	user := domain.User{
		ID: s.newID(), Email: email, DisplayName: displayName, SystemRole: domain.SystemRoleUser,
		Source: domain.SourceSCIM, Active: true, CreatedAt: now, UpdatedAt: now,
	}
	membership := domain.OrganizationMembership{
		ID: s.newID(), OrganizationID: authorization.OrganizationID, UserID: user.ID,
		Role: domain.OrganizationRoleMember, Source: domain.SourceSCIM, Active: input.Active,
		SCIMExternalID: strings.TrimSpace(input.ExternalID), SCIMUserName: email,
		CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.CreateUser(ctx, CreateUserCommand{
		OrganizationID: authorization.OrganizationID, ActorTokenID: authorization.TokenID,
		User: user, Membership: membership,
	})
}

func (s *Service) GetUser(ctx context.Context, authorization Authorization, resourceID string) (UserResource, error) {
	return s.repository.GetUser(ctx, authorization.OrganizationID, strings.TrimSpace(resourceID))
}

func (s *Service) ListUsers(ctx context.Context, authorization Authorization, query ListQuery) (UserPage, error) {
	query.OrganizationID = authorization.OrganizationID
	query.StartIndex, query.Count = normalizePage(query.StartIndex, query.Count)
	return s.repository.ListUsers(ctx, query)
}

func (s *Service) ReplaceUser(
	ctx context.Context,
	authorization Authorization,
	resourceID string,
	input UserInput,
) (UserResource, error) {
	current, err := s.repository.GetUser(ctx, authorization.OrganizationID, strings.TrimSpace(resourceID))
	if err != nil {
		return UserResource{}, err
	}
	if current.Membership.Source != domain.SourceSCIM || current.Membership.OrganizationID != authorization.OrganizationID {
		return UserResource{}, domain.ErrNotFound
	}
	email, displayName, err := normalizeUserInput(input)
	if err != nil {
		return UserResource{}, err
	}
	now := s.now().UTC()
	current.User.Email = email
	current.User.DisplayName = displayName
	current.User.UpdatedAt = now
	current.Membership.Active = input.Active
	current.Membership.SCIMExternalID = strings.TrimSpace(input.ExternalID)
	current.Membership.SCIMUserName = email
	current.Membership.UpdatedAt = now
	return s.repository.ReplaceUser(ctx, ReplaceUserCommand{
		OrganizationID: authorization.OrganizationID, ActorTokenID: authorization.TokenID,
		User: current.User, Membership: current.Membership,
	})
}

func (s *Service) DeactivateUser(ctx context.Context, authorization Authorization, resourceID string) (UserResource, error) {
	current, err := s.GetUser(ctx, authorization, resourceID)
	if err != nil {
		return UserResource{}, err
	}
	return s.ReplaceUser(ctx, authorization, resourceID, UserInput{
		ExternalID: current.Membership.SCIMExternalID, UserName: current.Membership.SCIMUserName,
		DisplayName: current.User.DisplayName, Active: false,
	})
}

func (s *Service) CreateGroup(ctx context.Context, authorization Authorization, input GroupInput) (GroupResource, error) {
	displayName, err := domain.NormalizeDisplayName(input.DisplayName)
	if err != nil {
		return GroupResource{}, err
	}
	memberIDs, err := normalizeMemberIDs(input.MemberIDs)
	if err != nil {
		return GroupResource{}, err
	}
	now := s.now().UTC()
	group := domain.Group{
		ID: s.newID(), OrganizationID: authorization.OrganizationID, DisplayName: displayName,
		Source: domain.SourceSCIM, Active: true, SCIMExternalID: strings.TrimSpace(input.ExternalID),
		CreatedAt: now, UpdatedAt: now,
	}
	return s.repository.CreateGroup(ctx, CreateGroupCommand{
		OrganizationID: authorization.OrganizationID, ActorTokenID: authorization.TokenID,
		Group: group, MemberIDs: memberIDs,
	})
}

func (s *Service) GetGroup(ctx context.Context, authorization Authorization, resourceID string) (GroupResource, error) {
	return s.repository.GetGroup(ctx, authorization.OrganizationID, strings.TrimSpace(resourceID))
}

func (s *Service) ListGroups(ctx context.Context, authorization Authorization, query ListQuery) (GroupPage, error) {
	query.OrganizationID = authorization.OrganizationID
	query.StartIndex, query.Count = normalizePage(query.StartIndex, query.Count)
	return s.repository.ListGroups(ctx, query)
}

func (s *Service) ReplaceGroup(
	ctx context.Context,
	authorization Authorization,
	resourceID string,
	input GroupInput,
) (GroupResource, error) {
	current, err := s.repository.GetGroup(ctx, authorization.OrganizationID, strings.TrimSpace(resourceID))
	if err != nil {
		return GroupResource{}, err
	}
	if current.Group.Source != domain.SourceSCIM || current.Group.OrganizationID != authorization.OrganizationID {
		return GroupResource{}, domain.ErrNotFound
	}
	displayName, err := domain.NormalizeDisplayName(input.DisplayName)
	if err != nil {
		return GroupResource{}, err
	}
	memberIDs, err := normalizeMemberIDs(input.MemberIDs)
	if err != nil {
		return GroupResource{}, err
	}
	current.Group.DisplayName = displayName
	current.Group.Active = true
	current.Group.SCIMExternalID = strings.TrimSpace(input.ExternalID)
	current.Group.UpdatedAt = s.now().UTC()
	return s.repository.ReplaceGroup(ctx, ReplaceGroupCommand{
		OrganizationID: authorization.OrganizationID,
		ActorTokenID:   authorization.TokenID,
		Group:          current.Group, MemberIDs: memberIDs,
	})
}

func (s *Service) DeleteGroup(ctx context.Context, authorization Authorization, resourceID string) error {
	groupID := strings.TrimSpace(resourceID)
	if groupID == "" {
		return domain.ErrNotFound
	}
	return s.repository.DeleteGroup(ctx, DeleteGroupCommand{
		OrganizationID: authorization.OrganizationID,
		ActorTokenID:   authorization.TokenID,
		GroupID:        groupID,
		DeletedAt:      s.now().UTC(),
	})
}

func normalizeUserInput(input UserInput) (string, string, error) {
	email, err := domain.NormalizeEmail(input.UserName)
	if err != nil {
		return "", "", fmt.Errorf("SCIM userName: %w", err)
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = email
	}
	displayName, err = domain.NormalizeDisplayName(displayName)
	if err != nil {
		return "", "", err
	}
	return email, displayName, nil
}

func normalizeMemberIDs(input []string) ([]string, error) {
	seen := make(map[string]struct{}, len(input))
	for _, value := range input {
		id := strings.TrimSpace(value)
		if id == "" {
			return nil, domain.InvalidArgument("SCIM group member value is required")
		}
		seen[id] = struct{}{}
	}
	result := make([]string, 0, len(seen))
	for id := range seen {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

func normalizePage(startIndex, count int) (int, int) {
	if startIndex < 1 {
		startIndex = 1
	}
	if count < 0 {
		count = 100
	}
	if count > 200 {
		count = 200
	}
	return startIndex, count
}

func containsScope(scopes []string, required string) bool {
	for _, scope := range scopes {
		if scope == required || scope == domain.SCIMScopeWrite && required == domain.SCIMScopeRead {
			return true
		}
	}
	return false
}
