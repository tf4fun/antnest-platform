package browsersessions

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type Deadlines struct {
	ExpiresAt          time.Time `json:"expires_at"`
	IdleExpiresAt      time.Time `json:"idle_expires_at"`
	ActivityIntervalMS int       `json:"activity_interval_ms"`
}

type Session struct {
	ID               string    `json:"id"`
	OrganizationID   string    `json:"organization_id"`
	OrganizationSlug string    `json:"organization_slug"`
	OrganizationName string    `json:"organization_name"`
	CreatedAt        time.Time `json:"created_at"`
	LastActiveAt     time.Time `json:"last_active_at"`
	IdleExpiresAt    time.Time `json:"idle_expires_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	UserAgentHint    string    `json:"user_agent_hint"`
	Current          bool      `json:"current"`
}

type Page struct {
	Sessions    []Session `json:"sessions"`
	NextAfterID string    `json:"next_after_id,omitempty"`
}

type ListInput struct {
	ActorPrincipalID string
	UserID           string
	Scope            string
	Limit            int
	AfterID          string
}

type RevokeInput struct {
	RequestID        string
	ActorPrincipalID string
	UserID           string
	Scope            string
	Mode             string
}

type RevokeResult struct {
	RevokedCount   int  `json:"revoked_count"`
	CurrentRevoked bool `json:"current_revoked"`
}

type RevocationQuery struct {
	AfterSequence int64
	Limit         int
}

// Access carries the original signed authority into the owning transaction.
// The repository revalidates Caller after locks, then checks its live principal.
type Access struct {
	Caller *callercontext.Caller
	UserID string
	Scope  string
}

func (a Access) Authorize(principal domain.Principal) error {
	if !principal.Active {
		return callercontext.ErrInvalid
	}
	switch a.Scope {
	case "self":
		if a.UserID != principal.UserID {
			return domain.ErrForbidden
		}
	case "organization":
		if !principal.CanAdminister(principal.OrganizationID) {
			return domain.ErrForbidden
		}
	default:
		return domain.InvalidArgument("scope must be self or organization")
	}
	return nil
}

type Repository interface {
	GetLocalCredential(context.Context, string) (domain.LocalCredential, error)
	ChangePassword(context.Context, PasswordCommand) (PasswordResult, error)
	Touch(context.Context, *callercontext.Caller) (Deadlines, error)
	List(context.Context, Access, ListInput) (Page, error)
	Revoke(context.Context, Access, RevokeInput) (RevokeResult, error)
	ListRevocations(context.Context, RevocationQuery) (domain.SessionRevocationPage, error)
}

type Service struct {
	repository Repository
	passwords  credentials.Passwords
}

func NewService(repository Repository, passwords credentials.Passwords) *Service {
	if repository == nil || passwords == nil {
		panic("browser sessions require repository and password engine")
	}
	return &Service{repository: repository, passwords: passwords}
}

func authenticatedActor(ctx context.Context, actor string) (*callercontext.Caller, error) {
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		return nil, err
	}
	if !domain.ValidID(actor) {
		return nil, domain.InvalidArgument("actor principal ID is invalid")
	}
	if caller.Claims().Subject != actor {
		return nil, domain.ErrForbidden
	}
	return caller, nil
}

func accessFor(ctx context.Context, actor, user, scope string) (Access, error) {
	caller, err := authenticatedActor(ctx, actor)
	if err != nil {
		return Access{}, err
	}
	if !domain.ValidID(user) {
		return Access{}, domain.InvalidArgument("user ID is invalid")
	}
	a := Access{Caller: caller, UserID: user, Scope: scope}
	claims := caller.Claims()
	if err := a.Authorize(domain.Principal{UserID: claims.Subject, OrganizationID: claims.Organization, MembershipID: claims.Membership, SystemRole: domain.SystemRole(claims.SystemRole), OrganizationRole: domain.OrganizationRole(claims.OrganizationRole), Active: true}); err != nil {
		return Access{}, err
	}
	return a, nil
}

func (s *Service) Touch(ctx context.Context, actor string) (Deadlines, error) {
	caller, err := authenticatedActor(ctx, actor)
	if err != nil {
		return Deadlines{}, err
	}
	return s.repository.Touch(ctx, caller)
}

func (s *Service) List(ctx context.Context, input ListInput) (Page, error) {
	access, err := accessFor(ctx, input.ActorPrincipalID, input.UserID, input.Scope)
	if err != nil {
		return Page{}, err
	}
	if input.Limit < 1 || input.Limit > 100 || input.AfterID != "" && !domain.ValidID(input.AfterID) {
		return Page{}, domain.InvalidArgument("limit must be between 1 and 100 and after_id must be a public reference")
	}
	return s.repository.List(ctx, access, input)
}

func (s *Service) Revoke(ctx context.Context, input RevokeInput) (RevokeResult, error) {
	access, err := accessFor(ctx, input.ActorPrincipalID, input.UserID, input.Scope)
	if err != nil {
		return RevokeResult{}, err
	}
	if !domain.ValidID(input.RequestID) || input.Mode != "all" && input.Mode != "others" || input.Scope == "organization" && input.Mode != "all" {
		return RevokeResult{}, domain.InvalidArgument("request ID or revocation mode is invalid")
	}
	return s.repository.Revoke(ctx, access, input)
}

func (s *Service) ListRevocations(ctx context.Context, query RevocationQuery) (domain.SessionRevocationPage, error) {
	if query.AfterSequence < 0 || query.Limit < 1 || query.Limit > 500 {
		return domain.SessionRevocationPage{}, domain.InvalidArgument("after_sequence must be nonnegative and limit must be between 1 and 500")
	}
	return s.repository.ListRevocations(ctx, query)
}
