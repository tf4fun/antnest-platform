// Package externalidentities owns explicit account binding and notice controls.
package externalidentities

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

type Binding struct {
	ID                  string     `json:"id"`
	ProviderID          string     `json:"provider_id"`
	ProviderName        string     `json:"provider_name"`
	ProviderDisplayName string     `json:"provider_display_name"`
	OrganizationID      string     `json:"organization_id"`
	OrganizationSlug    string     `json:"organization_slug"`
	OrganizationName    string     `json:"organization_name"`
	MembershipID        string     `json:"membership_id"`
	Subject             string     `json:"subject"`
	Method              string     `json:"method"`
	ProviderEnabled     bool       `json:"provider_enabled"`
	CreatedAt           time.Time  `json:"created_at"`
	BoundAt             time.Time  `json:"bound_at"`
	RevokedAt           *time.Time `json:"revoked_at"`
}

type Notice struct {
	ID                  string    `json:"id"`
	BindingID           string    `json:"binding_id"`
	ProviderID          string    `json:"provider_id"`
	ProviderName        string    `json:"provider_name"`
	ProviderDisplayName string    `json:"provider_display_name"`
	OrganizationID      string    `json:"organization_id"`
	OrganizationSlug    string    `json:"organization_slug"`
	OrganizationName    string    `json:"organization_name"`
	MembershipID        string    `json:"membership_id"`
	Subject             string    `json:"subject"`
	Method              string    `json:"method"`
	CreatedAt           time.Time `json:"created_at"`
}

type Page struct {
	Bindings          []Binding `json:"bindings"`
	Notices           *[]Notice `json:"notices,omitempty"`
	NextAfterID       string    `json:"next_after_id,omitempty"`
	NextNoticeAfterID string    `json:"next_notice_after_id,omitempty"`
}

type Provider struct {
	ID                       string   `json:"id"`
	Name                     string   `json:"name"`
	DisplayName              string   `json:"display_name"`
	Enabled                  bool     `json:"enabled"`
	LinkPolicy               string   `json:"link_policy"`
	LinkDomains              []string `json:"link_domains"`
	Authoritative            bool     `json:"authoritative"`
	LinkPolicyReviewRequired bool     `json:"link_policy_review_required"`
}

type ProvidersPage struct {
	Providers   []Provider `json:"providers"`
	NextAfterID string     `json:"next_after_id,omitempty"`
}

type ListInput struct {
	ActorPrincipalID, Scope, MembershipID string
	Limit                                 int
	AfterID, NoticeAfterID                string
}
type BindInput struct {
	RequestID, ActorPrincipalID, MembershipID, ProviderID, Subject string
	RestoreRevoked                                                 bool
}
type UnbindInput struct {
	RequestID, ActorPrincipalID, BindingID, Scope, MembershipID string
	AllowLockout                                                bool
}
type UnbindResult struct {
	RevokedCount   int  `json:"revoked_count"`
	CurrentRevoked bool `json:"current_revoked"`
}
type AcknowledgeInput struct {
	RequestID, ActorPrincipalID string
	NoticeIDs                   []string
}
type AcknowledgeResult struct {
	AcknowledgedCount int `json:"acknowledged_count"`
}
type ProvidersInput struct {
	ActorPrincipalID string
	Limit            int
	AfterID          string
}

// Access preserves the original signed authority for transactional revalidation.
type Access struct {
	Caller *callercontext.Caller
	Scope  string
}

func (a Access) Authorize(principal domain.Principal) error {
	if a.Caller == nil || !principal.Active || principal.UserID != a.Caller.Claims().Subject || principal.OrganizationID != a.Caller.Claims().Organization {
		return callercontext.ErrInvalid
	}
	switch a.Scope {
	case "self":
		return nil
	case "organization":
		if principal.OrganizationID != "" && principal.CanAdminister(principal.OrganizationID) {
			return nil
		}
		return domain.ErrForbidden
	default:
		return domain.InvalidArgument("scope must be self or organization")
	}
}

type Repository interface {
	List(context.Context, Access, ListInput) (Page, error)
	Bind(context.Context, Access, BindInput) (Binding, error)
	Unbind(context.Context, Access, UnbindInput) (UnbindResult, error)
	Acknowledge(context.Context, Access, AcknowledgeInput) (AcknowledgeResult, error)
	ListProviders(context.Context, Access, ProvidersInput) (ProvidersPage, error)
}
type Service struct{ repository Repository }

func NewService(repository Repository) *Service {
	if repository == nil {
		panic("external identities require repository")
	}
	return &Service{repository: repository}
}

func accessFor(ctx context.Context, actor, scope string) (Access, error) {
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		return Access{}, err
	}
	if !domain.ValidID(actor) {
		return Access{}, domain.InvalidArgument("actor principal ID is invalid")
	}
	claims := caller.Claims()
	if claims.Subject != actor {
		return Access{}, domain.ErrForbidden
	}
	a := Access{Caller: caller, Scope: scope}
	err = a.Authorize(domain.Principal{UserID: claims.Subject, OrganizationID: claims.Organization, MembershipID: claims.Membership, SystemRole: domain.SystemRole(claims.SystemRole), OrganizationRole: domain.OrganizationRole(claims.OrganizationRole), Active: true})
	return a, err
}

func validPage(limit int, cursors ...string) bool {
	if limit < 1 || limit > 100 {
		return false
	}
	for _, cursor := range cursors {
		if cursor != "" && !domain.ValidID(cursor) {
			return false
		}
	}
	return true
}
func validTarget(scope, membership string) bool {
	return scope == "self" && membership == "" || scope == "organization" && domain.ValidID(membership)
}

func (s *Service) List(ctx context.Context, input ListInput) (Page, error) {
	a, err := accessFor(ctx, input.ActorPrincipalID, input.Scope)
	if err != nil {
		return Page{}, err
	}
	if !validTarget(input.Scope, input.MembershipID) || !validPage(input.Limit, input.AfterID, input.NoticeAfterID) || input.Scope == "organization" && input.NoticeAfterID != "" {
		return Page{}, domain.InvalidArgument("invalid binding inventory scope or pagination")
	}
	return s.repository.List(ctx, a, input)
}
func (s *Service) Bind(ctx context.Context, input BindInput) (Binding, error) {
	a, err := accessFor(ctx, input.ActorPrincipalID, "organization")
	if err != nil {
		return Binding{}, err
	}
	if !domain.ValidID(input.RequestID) || !domain.ValidID(input.MembershipID) || !domain.ValidID(input.ProviderID) || !oidcflow.ValidSubject(input.Subject) {
		return Binding{}, domain.InvalidArgument("invalid binding target or subject")
	}
	return s.repository.Bind(ctx, a, input)
}
func (s *Service) Unbind(ctx context.Context, input UnbindInput) (UnbindResult, error) {
	a, err := accessFor(ctx, input.ActorPrincipalID, input.Scope)
	if err != nil {
		return UnbindResult{}, err
	}
	if !domain.ValidID(input.RequestID) || !domain.ValidID(input.BindingID) || !validTarget(input.Scope, input.MembershipID) {
		return UnbindResult{}, domain.InvalidArgument("invalid unbinding target")
	}
	return s.repository.Unbind(ctx, a, input)
}
func (s *Service) Acknowledge(ctx context.Context, input AcknowledgeInput) (AcknowledgeResult, error) {
	a, err := accessFor(ctx, input.ActorPrincipalID, "self")
	if err != nil {
		return AcknowledgeResult{}, err
	}
	if !domain.ValidID(input.RequestID) || len(input.NoticeIDs) < 1 || len(input.NoticeIDs) > 100 {
		return AcknowledgeResult{}, domain.InvalidArgument("notice_ids must contain 1 to 100 distinct references")
	}
	seen := make(map[string]bool, len(input.NoticeIDs))
	for _, id := range input.NoticeIDs {
		if !domain.ValidID(id) || seen[id] {
			return AcknowledgeResult{}, domain.InvalidArgument("notice_ids must contain distinct public references")
		}
		seen[id] = true
	}
	return s.repository.Acknowledge(ctx, a, input)
}
func (s *Service) ListProviders(ctx context.Context, input ProvidersInput) (ProvidersPage, error) {
	a, err := accessFor(ctx, input.ActorPrincipalID, "organization")
	if err != nil {
		return ProvidersPage{}, err
	}
	if !validPage(input.Limit, input.AfterID) {
		return ProvidersPage{}, domain.InvalidArgument("invalid Provider pagination")
	}
	return s.repository.ListProviders(ctx, a, input)
}
