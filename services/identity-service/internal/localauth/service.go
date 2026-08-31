package localauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	FindLocalCredential(context.Context, string, string) (LocalCredential, error)
	IssueToken(context.Context, IssueTokenCommand) (Token, error)
	ResolveToken(context.Context, string, time.Time) (domain.Principal, error)
	RevokeToken(context.Context, string, string, time.Time) error
}

type LocalCredential struct {
	PasswordHash string
	Principal    domain.Principal
}

type LoginInput struct {
	RequestID        string
	OrganizationSlug string
	Email            string
	Password         string
}

type IssueTokenCommand struct {
	TokenID   string
	TokenHash string
	Principal domain.Principal
	RequestID string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

type Token struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type LoginResult struct {
	Principal   domain.Principal `json:"principal"`
	TokenID     string           `json:"token_id"`
	AccessToken string           `json:"access_token"`
	ExpiresAt   time.Time        `json:"expires_at"`
}

type Service struct {
	repository Repository
	newID      func() string
	now        func() time.Time
	tokenTTL   time.Duration
	dummyHash  string
}

func NewService(
	repository Repository,
	newID func() string,
	now func() time.Time,
	tokenTTL time.Duration,
) (*Service, error) {
	if repository == nil || newID == nil || now == nil {
		return nil, fmt.Errorf("local auth requires repository, id generator, and clock")
	}
	if tokenTTL <= 0 {
		return nil, fmt.Errorf("access token TTL must be positive")
	}
	dummyHash, err := credentials.HashPassword("antnest-invalid-account-password")
	if err != nil {
		return nil, fmt.Errorf("prepare password timing defense: %w", err)
	}
	return &Service{
		repository: repository,
		newID:      newID,
		now:        now,
		tokenTTL:   tokenTTL,
		dummyHash:  dummyHash,
	}, nil
}

func (s *Service) Login(ctx context.Context, input LoginInput) (LoginResult, error) {
	slug, email, validInput := normalizeLoginIdentity(input.OrganizationSlug, input.Email)
	credential, lookupErr := s.lookupCredential(ctx, slug, email, validInput)
	encoded := credential.PasswordHash
	if lookupErr != nil || !validInput {
		encoded = s.dummyHash
	}
	passwordMatches, verifyErr := credentials.VerifyPassword(encoded, input.Password)
	if verifyErr != nil && lookupErr == nil && validInput {
		return LoginResult{}, fmt.Errorf("verify stored password: %w", verifyErr)
	}
	if lookupErr != nil && !errors.Is(lookupErr, domain.ErrNotFound) {
		return LoginResult{}, fmt.Errorf("find local credential: %w", lookupErr)
	}
	if !validInput || lookupErr != nil || !passwordMatches || !credential.Principal.Active {
		return LoginResult{}, domain.ErrUnauthenticated
	}

	rawToken, tokenHash, err := credentials.NewOpaqueToken("ant_api_")
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now().UTC()
	expiresAt := now.Add(s.tokenTTL)
	token, err := s.repository.IssueToken(ctx, IssueTokenCommand{
		TokenID: s.newID(), TokenHash: tokenHash, Principal: credential.Principal,
		RequestID: input.RequestID, IssuedAt: now, ExpiresAt: expiresAt,
	})
	if err != nil {
		return LoginResult{}, fmt.Errorf("issue access token: %w", err)
	}
	return LoginResult{
		Principal: credential.Principal, TokenID: token.ID, AccessToken: rawToken, ExpiresAt: token.ExpiresAt,
	}, nil
}

func (s *Service) Resolve(ctx context.Context, rawToken string) (domain.Principal, error) {
	if rawToken == "" {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	principal, err := s.repository.ResolveToken(ctx, credentials.HashToken(rawToken), s.now().UTC())
	if errors.Is(err, domain.ErrNotFound) {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return domain.Principal{}, fmt.Errorf("resolve access token: %w", err)
	}
	if !principal.Active {
		return domain.Principal{}, domain.ErrUnauthenticated
	}
	return principal, nil
}

func (s *Service) Revoke(ctx context.Context, actorPrincipalID, tokenID string) error {
	if tokenID == "" {
		return domain.ErrNotFound
	}
	if err := s.repository.RevokeToken(
		ctx,
		actorPrincipalID,
		tokenID,
		s.now().UTC(),
	); err != nil {
		return fmt.Errorf("revoke access token: %w", err)
	}
	return nil
}

func normalizeLoginIdentity(organizationSlug, email string) (string, string, bool) {
	slug, slugErr := domain.NormalizeSlug(organizationSlug)
	normalizedEmail, emailErr := domain.NormalizeEmail(email)
	return slug, normalizedEmail, slugErr == nil && emailErr == nil
}

func (s *Service) lookupCredential(
	ctx context.Context,
	organizationSlug string,
	email string,
	validInput bool,
) (LocalCredential, error) {
	if !validInput {
		return LocalCredential{}, domain.ErrNotFound
	}
	return s.repository.FindLocalCredential(ctx, organizationSlug, email)
}
