package localauth

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	FindLocalCredential(context.Context, string, string) (LocalCredential, error)
	IssueToken(context.Context, IssueTokenCommand) (Token, error)
	ResolveToken(context.Context, string, time.Time) (domain.Principal, error)
	RevokeByTokenHash(context.Context, string, time.Time) (RevokeStatus, error)
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
	UserAgentHint    string
}

type IssueTokenCommand struct {
	TokenID              string
	TokenHash            string
	Principal            domain.Principal
	ExpectedPasswordHash string
	RequestID            string
	IssuedAt             time.Time
	ExpiresAt            time.Time
	UserAgentHint        string
}

type Token struct {
	ID                 string    `json:"id"`
	ExpiresAt          time.Time `json:"expires_at"`
	IdleExpiresAt      time.Time `json:"idle_expires_at"`
	ActivityIntervalMS int       `json:"activity_interval_ms"`
}

type LoginResult struct {
	Principal          domain.Principal `json:"principal"`
	TokenID            string           `json:"token_id"`
	AccessToken        string           `json:"access_token"`
	ExpiresAt          time.Time        `json:"expires_at"`
	IdleExpiresAt      time.Time        `json:"idle_expires_at"`
	ActivityIntervalMS int              `json:"activity_interval_ms"`
}

type RevokeStatus string

const (
	RevokeStatusRevoked        RevokeStatus = "revoked"
	RevokeStatusAlreadyInvalid RevokeStatus = "already_invalid"
)

type Service struct {
	repository Repository
	newID      func(string) string
	now        func() time.Time
	tokenTTL   time.Duration
	dummyHash  string
	passwords  credentials.Passwords
}

func NewService(
	ctx context.Context,
	repository Repository,
	newID func(string) string,
	now func() time.Time,
	tokenTTL time.Duration,
	passwords credentials.Passwords,
) (*Service, error) {
	if repository == nil || newID == nil || now == nil || passwords == nil {
		return nil, fmt.Errorf("local auth requires repository, id generator, clock, and password engine")
	}
	if tokenTTL <= 0 {
		return nil, fmt.Errorf("access token TTL must be positive")
	}
	dummyHash, err := passwords.HashPassword(ctx, "antnest-invalid-account-password")
	if err != nil {
		return nil, fmt.Errorf("prepare password timing defense: %w", err)
	}
	return &Service{
		repository: repository,
		newID:      newID,
		now:        now,
		tokenTTL:   tokenTTL,
		dummyHash:  dummyHash,
		passwords:  passwords,
	}, nil
}

func (s *Service) Login(ctx context.Context, input LoginInput) (LoginResult, error) {
	if utf8.RuneCountInString(input.UserAgentHint) > 256 {
		return LoginResult{}, domain.InvalidArgument("user_agent_hint must contain at most 256 characters")
	}
	slug, email, validInput := normalizeLoginIdentity(input.OrganizationSlug, input.Email)
	credential, lookupErr := s.lookupCredential(ctx, slug, email, validInput)
	encoded := credential.PasswordHash
	realCredential := lookupErr == nil && validInput && credential.Principal.Active && encoded != ""
	if !realCredential {
		encoded = s.dummyHash
	}
	passwordMatches, verifyErr := s.passwords.VerifyPassword(ctx, encoded, input.Password)
	if verifyErr != nil {
		return LoginResult{}, fmt.Errorf("verify local password: %w", verifyErr)
	}
	if lookupErr != nil && !errors.Is(lookupErr, domain.ErrNotFound) {
		return LoginResult{}, fmt.Errorf("find local credential: %w", lookupErr)
	}
	if !realCredential || !passwordMatches {
		return LoginResult{}, domain.ErrUnauthenticated
	}

	rawToken, tokenHash, err := credentials.NewOpaqueToken("ant_api_")
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now().UTC()
	expiresAt := now.Add(s.tokenTTL)
	token, err := s.repository.IssueToken(ctx, IssueTokenCommand{
		TokenID: s.newID("authtoken"), TokenHash: tokenHash, Principal: credential.Principal,
		ExpectedPasswordHash: credential.PasswordHash,
		RequestID:            input.RequestID, IssuedAt: now, ExpiresAt: expiresAt,
		UserAgentHint: input.UserAgentHint,
	})
	if err != nil {
		return LoginResult{}, fmt.Errorf("issue access token: %w", err)
	}
	return LoginResult{
		Principal: credential.Principal, TokenID: token.ID, AccessToken: rawToken, ExpiresAt: token.ExpiresAt,
		IdleExpiresAt: token.IdleExpiresAt, ActivityIntervalMS: token.ActivityIntervalMS,
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

func (s *Service) RevokeByAccessToken(
	ctx context.Context, rawToken string,
) (RevokeStatus, error) {
	if rawToken == "" {
		return RevokeStatusAlreadyInvalid, nil
	}
	status, err := s.repository.RevokeByTokenHash(
		ctx, credentials.HashToken(rawToken), s.now().UTC(),
	)
	if err != nil {
		return "", fmt.Errorf("revoke access token: %w", err)
	}
	return status, nil
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
