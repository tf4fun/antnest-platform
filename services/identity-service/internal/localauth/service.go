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
	Login(context.Context, LoginAttempt, PrepareLogin) (LoginOutcome, error)
	ResolveToken(context.Context, string, time.Time) (domain.Principal, error)
	RevokeByTokenHash(context.Context, string, time.Time) (RevokeStatus, error)
}

type LocalCredential struct {
	PasswordHash string
	Principal    domain.Principal
}

type LoginAttempt struct {
	OrganizationSlug string
	Email            string
}

// PrepareLogin runs once after the repository has locked admission and the
// authoritative credential. It uses the original request context for KDF work.
// A non-match is an outcome to commit, while an error aborts the transaction.
type PrepareLogin func(context.Context, LocalCredential) (LoginPreparation, error)

type LoginPreparation struct {
	Matched                 bool
	ReplacementPasswordHash string
	IssueToken              IssueTokenCommand
}

type LoginOutcome struct {
	Authenticated bool
	Principal     domain.Principal
	Token         Token
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
	passwords  credentials.LoginPasswords
}

func NewService(
	ctx context.Context,
	repository Repository,
	newID func(string) string,
	now func() time.Time,
	tokenTTL time.Duration,
	passwords credentials.LoginPasswords,
) (*Service, error) {
	if repository == nil || newID == nil || now == nil || passwords == nil {
		return nil, fmt.Errorf("local auth requires repository, id generator, clock, and password engine")
	}
	if tokenTTL <= 0 {
		return nil, fmt.Errorf("access token TTL must be positive")
	}
	dummyHash, err := passwords.DummyHash(ctx)
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
	if !validInput {
		if _, err := s.passwords.VerifyPassword(ctx, s.dummyHash, input.Password); err != nil {
			return LoginResult{}, fmt.Errorf("verify invalid local login: %w", err)
		}
		return LoginResult{}, domain.ErrUnauthenticated
	}
	// Freeze issuance deadlines before any database admission or credential
	// wait. Verification must not grant the request a fresh lifetime afterwards.
	issuedAt := s.now().UTC()
	var rawToken string
	outcome, err := s.repository.Login(ctx, LoginAttempt{OrganizationSlug: slug, Email: email},
		func(original context.Context, credential LocalCredential) (LoginPreparation, error) {
			prepared, raw, err := s.prepareLogin(original, input, credential, issuedAt)
			rawToken = raw
			return prepared, err
		})
	if err != nil {
		return LoginResult{}, fmt.Errorf("complete local login: %w", err)
	}
	if !outcome.Authenticated {
		return LoginResult{}, domain.ErrUnauthenticated
	}
	token := outcome.Token
	return LoginResult{
		Principal: outcome.Principal, TokenID: token.ID, AccessToken: rawToken, ExpiresAt: token.ExpiresAt,
		IdleExpiresAt: token.IdleExpiresAt, ActivityIntervalMS: token.ActivityIntervalMS,
	}, nil
}

func (s *Service) prepareLogin(ctx context.Context, input LoginInput, credential LocalCredential, issuedAt time.Time) (LoginPreparation, string, error) {
	encoded := credential.PasswordHash
	realCredential := credential.Principal.Active && encoded != ""
	if !realCredential {
		encoded = s.dummyHash
	}
	passwordMatches, verifyErr := s.passwords.VerifyPassword(ctx, encoded, input.Password)
	if verifyErr != nil {
		return LoginPreparation{}, "", fmt.Errorf("verify local password: %w", verifyErr)
	}
	if !realCredential || !passwordMatches {
		return LoginPreparation{}, "", nil
	}
	needsRehash, err := s.passwords.NeedsRehash(encoded)
	if err != nil {
		return LoginPreparation{}, "", fmt.Errorf("inspect verified local password: %w", err)
	}
	var replacement string
	if needsRehash {
		replacement, err = s.passwords.HashPassword(ctx, input.Password)
		if err != nil {
			return LoginPreparation{}, "", fmt.Errorf("upgrade local password: %w", err)
		}
	}

	rawToken, tokenHash, err := credentials.NewOpaqueToken("ant_api_")
	if err != nil {
		return LoginPreparation{}, "", err
	}
	command := IssueTokenCommand{
		TokenID: s.newID("authtoken"), TokenHash: tokenHash, Principal: credential.Principal,
		ExpectedPasswordHash: credential.PasswordHash,
		RequestID:            input.RequestID, IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(s.tokenTTL),
		UserAgentHint: input.UserAgentHint,
	}
	return LoginPreparation{Matched: true, ReplacementPasswordHash: replacement, IssueToken: command}, rawToken, nil
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
