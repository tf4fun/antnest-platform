package oidcflow

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

type Repository interface {
	GetPrincipal(context.Context, string, string) (domain.Principal, error)
	FindProvider(context.Context, string, string) (ProviderWithSecret, error)
	FindLoginProvider(context.Context, string, string) (ProviderWithSecret, error)
	GetProvider(context.Context, string) (ProviderWithSecret, error)
	UpsertProvider(context.Context, UpsertProviderCommand) (Provider, error)
	SetProviderEnabled(context.Context, SetProviderEnabledCommand) (Provider, error)
	ListLoginMethods(context.Context, string) ([]LoginMethod, error)
	CreateSession(context.Context, CreateSessionCommand) error
	ClaimSession(context.Context, string, string, time.Time) (SessionClaim, error)
	CompleteLogin(context.Context, CompleteLoginCommand) (CompletedLogin, error)
	FailSession(context.Context, FailSessionCommand) error
}

type Federation interface {
	Discover(context.Context, string) (Discovery, error)
	AuthorizationURL(AuthorizationInput) (string, error)
	ExchangeAndVerify(context.Context, ExchangeInput) (VerifiedIdentity, error)
}

type Provider struct {
	ID                    string                   `json:"id"`
	OrganizationID        string                   `json:"organization_id"`
	Name                  string                   `json:"name"`
	DisplayName           string                   `json:"display_name"`
	Issuer                string                   `json:"issuer"`
	ClientID              string                   `json:"client_id"`
	ClientSecret          credentials.SealedSecret `json:"-"`
	RedirectURI           string                   `json:"redirect_uri"`
	Scopes                []string                 `json:"scopes"`
	Enabled               bool                     `json:"enabled"`
	AuthorizationEndpoint string                   `json:"authorization_endpoint"`
	TokenEndpoint         string                   `json:"token_endpoint"`
	UserInfoEndpoint      string                   `json:"userinfo_endpoint,omitempty"`
	JWKSURI               string                   `json:"jwks_uri"`
	CreatedAt             time.Time                `json:"created_at"`
	UpdatedAt             time.Time                `json:"updated_at"`
}

type ProviderWithSecret struct{ Provider }

type Discovery struct {
	Issuer                string
	AuthorizationEndpoint string
	TokenEndpoint         string
	UserInfoEndpoint      string
	JWKSURI               string
}

type LoginMethod struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
}

type UpsertProviderInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	Name             string
	Issuer           string
	ClientID         string
	ClientSecret     string
	RedirectURI      string
	Scopes           []string
	Enabled          bool
}

type UpsertProviderCommand struct {
	ActorPrincipalID string
	RequestID        string
	Provider         ProviderWithSecret
}

type SetProviderEnabledInput struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	Name             string
	Enabled          bool
}

type SetProviderEnabledCommand struct {
	RequestID        string
	ActorPrincipalID string
	OrganizationID   string
	Name             string
	Enabled          bool
	UpdatedAt        time.Time
}

type StartLoginInput struct {
	RequestID        string
	OrganizationSlug string
	ProviderName     string
}

type StartLoginResult struct {
	AuthorizationURL string    `json:"authorization_url"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type AuthorizationInput struct {
	Provider      Provider
	State         string
	Nonce         string
	PKCEChallenge string
}

type ExchangeInput struct {
	Provider     Provider
	ClientSecret string
	Code         string
	Nonce        string
	PKCEVerifier string
}

type VerifiedIdentity struct {
	Issuer        string
	Subject       string
	Email         string
	EmailVerified bool
	DisplayName   string
}

type SessionStatus string

const (
	SessionStatusPending      SessionStatus = "pending"
	SessionStatusExchanging   SessionStatus = "exchanging"
	SessionStatusCompleted    SessionStatus = "completed"
	SessionStatusFailed       SessionStatus = "failed"
	failurePersistenceTimeout               = 5 * time.Second
)

type AuthSession struct {
	ID             string
	RequestID      string
	ProviderID     string
	OrganizationID string
	Status         SessionStatus
	Secrets        credentials.SealedSecret
	ExpiresAt      time.Time
	CreatedAt      time.Time
}

type CreateSessionCommand struct {
	RequestID string
	Session   AuthSession
	StateHash string
}

type ClaimDisposition string

const (
	ClaimAcquired  ClaimDisposition = "acquired"
	ClaimCompleted ClaimDisposition = "completed"
	ClaimExpired   ClaimDisposition = "expired"
)

type SessionClaim struct {
	Disposition ClaimDisposition
	Session     AuthSession
	Completed   CompletedLogin
}

type CompleteLoginInput struct {
	State string
	Code  string
}

type CompleteLoginCommand struct {
	SessionID       string
	ProviderID      string
	OrganizationID  string
	ClaimID         string
	Identity        VerifiedIdentity
	AccessTokenID   string
	AccessTokenHash string
	IssuedAt        time.Time
	ExpiresAt       time.Time
}

type CompletedLogin struct {
	SessionID string
	TokenID   string
	Principal domain.Principal
	ExpiresAt time.Time
}

type CompleteLoginResult struct {
	Principal        domain.Principal `json:"principal"`
	TokenID          string           `json:"token_id"`
	AccessToken      string           `json:"access_token,omitempty"`
	AlreadyCompleted bool             `json:"already_completed,omitempty"`
	ExpiresAt        time.Time        `json:"expires_at"`
}

type FailSessionCommand struct {
	SessionID string
	ClaimID   string
	Stage     string
	Reason    string
	FailedAt  time.Time
}

type Config struct {
	Repository Repository
	Federation Federation
	SecretBox  *credentials.SecretBox
	NewID      func() string
	NewOpaque  func(string) (string, string, error)
	Now        func() time.Time
	SessionTTL time.Duration
	TokenTTL   time.Duration
}

type Service struct {
	repository Repository
	federation Federation
	secretBox  *credentials.SecretBox
	newID      func() string
	newOpaque  func(string) (string, string, error)
	now        func() time.Time
	sessionTTL time.Duration
	tokenTTL   time.Duration
}

func NewService(config Config) (*Service, error) {
	if config.Repository == nil || config.Federation == nil || config.SecretBox == nil ||
		config.NewID == nil || config.NewOpaque == nil || config.Now == nil {
		return nil, fmt.Errorf("OIDC flow requires repository, federation, secret box, generators, and clock")
	}
	if config.SessionTTL <= 0 || config.TokenTTL <= 0 {
		return nil, fmt.Errorf("OIDC session and token TTLs must be positive")
	}
	return &Service{
		repository: config.Repository, federation: config.Federation, secretBox: config.SecretBox,
		newID: config.NewID, newOpaque: config.NewOpaque, now: config.Now,
		sessionTTL: config.SessionTTL, tokenTTL: config.TokenTTL,
	}, nil
}

func (s *Service) UpsertProvider(ctx context.Context, input UpsertProviderInput) (Provider, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return Provider{}, fmt.Errorf("resolve OIDC provider actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return Provider{}, domain.ErrForbidden
	}

	name, err := domain.NormalizeSlug(input.Name)
	if err != nil {
		return Provider{}, fmt.Errorf("provider name: %w", err)
	}
	displayName, err := domain.NormalizeDisplayName(input.Name)
	if err != nil {
		return Provider{}, fmt.Errorf("provider display name: %w", err)
	}
	issuer, err := normalizeHTTPURL(input.Issuer, "issuer", true)
	if err != nil {
		return Provider{}, domain.InvalidArgument(err.Error())
	}
	redirectURI, err := normalizeHTTPURL(input.RedirectURI, "redirect URI", false)
	if err != nil {
		return Provider{}, domain.InvalidArgument(err.Error())
	}
	clientID := strings.TrimSpace(input.ClientID)
	if clientID == "" {
		return Provider{}, domain.InvalidArgument("client ID is required")
	}

	discovery, err := s.federation.Discover(ctx, issuer)
	if err != nil {
		return Provider{}, fmt.Errorf("discover OIDC provider: %w", err)
	}
	discoveredIssuer, issuerErr := normalizeHTTPURL(discovery.Issuer, "discovery issuer", true)
	if issuerErr != nil || discoveredIssuer != issuer {
		return Provider{}, fmt.Errorf("discovery issuer does not exactly match configured issuer")
	}
	if err := validateDiscovery(discovery); err != nil {
		return Provider{}, err
	}

	existing, findErr := s.repository.FindProvider(ctx, input.OrganizationID, name)
	if findErr != nil && !errors.Is(findErr, domain.ErrNotFound) {
		return Provider{}, fmt.Errorf("find OIDC provider: %w", findErr)
	}
	if findErr == nil && existing.Issuer != issuer {
		return Provider{}, domain.NewError(
			"oidc_provider_issuer_immutable",
			"Disable this OIDC Provider and create a new Provider name for the new issuer",
			false,
		)
	}
	now := s.now().UTC()
	providerID, createdAt := existing.ID, existing.CreatedAt
	if providerID == "" {
		providerID, createdAt = s.newID(), now
	}
	sealedSecret := existing.ClientSecret
	if input.ClientSecret != "" {
		sealedSecret, err = s.secretBox.Seal(
			[]byte(input.ClientSecret),
			providerSecretAAD(input.OrganizationID, name),
		)
		if err != nil {
			return Provider{}, fmt.Errorf("seal OIDC client secret: %w", err)
		}
	}
	if len(sealedSecret.Ciphertext) == 0 {
		return Provider{}, domain.InvalidArgument("client secret is required")
	}

	provider := ProviderWithSecret{Provider: Provider{
		ID: providerID, OrganizationID: input.OrganizationID, Name: name, DisplayName: displayName,
		Issuer: issuer, ClientID: clientID, ClientSecret: sealedSecret, RedirectURI: redirectURI,
		Scopes: normalizeScopes(input.Scopes), Enabled: input.Enabled,
		AuthorizationEndpoint: strings.TrimSpace(discovery.AuthorizationEndpoint),
		TokenEndpoint:         strings.TrimSpace(discovery.TokenEndpoint),
		UserInfoEndpoint:      strings.TrimSpace(discovery.UserInfoEndpoint), JWKSURI: strings.TrimSpace(discovery.JWKSURI),
		CreatedAt: createdAt, UpdatedAt: now,
	}}
	return s.repository.UpsertProvider(ctx, UpsertProviderCommand{
		ActorPrincipalID: input.ActorPrincipalID, RequestID: input.RequestID, Provider: provider,
	})
}

func (s *Service) SetProviderEnabled(
	ctx context.Context,
	input SetProviderEnabledInput,
) (Provider, error) {
	principal, err := s.repository.GetPrincipal(ctx, input.ActorPrincipalID, input.OrganizationID)
	if err != nil {
		return Provider{}, fmt.Errorf("resolve OIDC provider actor: %w", err)
	}
	if !principal.CanAdminister(input.OrganizationID) {
		return Provider{}, domain.ErrForbidden
	}
	name, err := domain.NormalizeSlug(input.Name)
	if err != nil {
		return Provider{}, fmt.Errorf("provider name: %w", err)
	}
	return s.repository.SetProviderEnabled(ctx, SetProviderEnabledCommand{
		RequestID: input.RequestID, ActorPrincipalID: input.ActorPrincipalID,
		OrganizationID: input.OrganizationID, Name: name, Enabled: input.Enabled,
		UpdatedAt: s.now().UTC(),
	})
}

func (s *Service) ListLoginMethods(ctx context.Context, organizationSlug string) ([]LoginMethod, error) {
	slug, err := domain.NormalizeSlug(organizationSlug)
	if err != nil {
		return nil, err
	}
	return s.repository.ListLoginMethods(ctx, slug)
}

func (s *Service) StartLogin(ctx context.Context, input StartLoginInput) (StartLoginResult, error) {
	slug, err := domain.NormalizeSlug(input.OrganizationSlug)
	if err != nil {
		return StartLoginResult{}, err
	}
	name, err := domain.NormalizeSlug(input.ProviderName)
	if err != nil {
		return StartLoginResult{}, err
	}
	provider, err := s.repository.FindLoginProvider(ctx, slug, name)
	if err != nil {
		return StartLoginResult{}, fmt.Errorf("find OIDC provider for login: %w", err)
	}
	if !provider.Enabled {
		return StartLoginResult{}, domain.ErrForbidden
	}

	state, stateHash, err := s.newOpaque("oidc_state_")
	if err != nil {
		return StartLoginResult{}, fmt.Errorf("generate OIDC state: %w", err)
	}
	nonce, _, err := s.newOpaque("oidc_nonce_")
	if err != nil {
		return StartLoginResult{}, fmt.Errorf("generate OIDC nonce: %w", err)
	}
	verifier, _, err := s.newOpaque("oidc_pkce_")
	if err != nil {
		return StartLoginResult{}, fmt.Errorf("generate PKCE verifier: %w", err)
	}
	sessionID := s.newID()
	sealed, err := sealSessionSecrets(s.secretBox, sessionID, sessionSecrets{Nonce: nonce, PKCEVerifier: verifier})
	if err != nil {
		return StartLoginResult{}, err
	}
	authorizationURL, err := s.federation.AuthorizationURL(AuthorizationInput{
		Provider: provider.Provider, State: state, Nonce: nonce, PKCEChallenge: pkceChallenge(verifier),
	})
	if err != nil {
		return StartLoginResult{}, fmt.Errorf("build OIDC authorization URL: %w", err)
	}
	now := s.now().UTC()
	expiresAt := now.Add(s.sessionTTL)
	if err := s.repository.CreateSession(ctx, CreateSessionCommand{
		RequestID: input.RequestID, StateHash: stateHash,
		Session: AuthSession{
			ID: sessionID, ProviderID: provider.ID, OrganizationID: provider.OrganizationID,
			Status: SessionStatusPending, Secrets: sealed, ExpiresAt: expiresAt, CreatedAt: now,
		},
	}); err != nil {
		return StartLoginResult{}, fmt.Errorf("create OIDC session: %w", err)
	}
	return StartLoginResult{AuthorizationURL: authorizationURL, ExpiresAt: expiresAt}, nil
}

func (s *Service) CompleteLogin(ctx context.Context, input CompleteLoginInput) (CompleteLoginResult, error) {
	state := strings.TrimSpace(input.State)
	if state == "" {
		return CompleteLoginResult{}, domain.InvalidArgument("OIDC state is required")
	}
	claimID := s.newID()
	claim, err := s.repository.ClaimSession(ctx, credentials.HashToken(state), claimID, s.now().UTC())
	if err != nil {
		return CompleteLoginResult{}, fmt.Errorf("claim OIDC session: %w", err)
	}
	if claim.Disposition == ClaimCompleted {
		return CompleteLoginResult{
			Principal: claim.Completed.Principal, TokenID: claim.Completed.TokenID,
			ExpiresAt: claim.Completed.ExpiresAt, AlreadyCompleted: true,
		}, nil
	}
	if claim.Disposition == ClaimExpired {
		return CompleteLoginResult{}, domain.NewError("oidc_session_expired", "OIDC login session expired", false)
	}
	if claim.Disposition != ClaimAcquired {
		return CompleteLoginResult{}, fmt.Errorf("unknown OIDC session claim disposition %q", claim.Disposition)
	}
	if strings.TrimSpace(input.Code) == "" {
		return CompleteLoginResult{}, s.failSession(
			ctx,
			claim.Session,
			claimID,
			"authorization",
			domain.InvalidArgument("OIDC authorization code is required"),
		)
	}

	secrets, err := openSessionSecrets(s.secretBox, claim.Session.ID, claim.Session.Secrets)
	if err != nil {
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "session", err)
	}
	provider, err := s.repository.GetProvider(ctx, claim.Session.ProviderID)
	if err != nil || !provider.Enabled {
		if err == nil {
			err = domain.ErrForbidden
		}
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "provider", err)
	}
	clientSecret, err := s.secretBox.Open(
		provider.ClientSecret,
		providerSecretAAD(provider.OrganizationID, provider.Name),
	)
	if err != nil {
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "provider_secret", err)
	}
	identity, err := s.federation.ExchangeAndVerify(ctx, ExchangeInput{
		Provider: provider.Provider, ClientSecret: string(clientSecret), Code: input.Code,
		Nonce: secrets.Nonce, PKCEVerifier: secrets.PKCEVerifier,
	})
	if err != nil {
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "exchange", err)
	}
	identity, err = validateIdentity(provider.Provider, identity)
	if err != nil {
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "identity", err)
	}

	rawToken, tokenHash, err := s.newOpaque("ant_api_")
	if err != nil {
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "token", err)
	}
	now := s.now().UTC()
	tokenID := s.newID()
	completed, err := s.repository.CompleteLogin(ctx, CompleteLoginCommand{
		SessionID: claim.Session.ID, ProviderID: provider.ID, OrganizationID: claim.Session.OrganizationID,
		ClaimID: claimID, Identity: identity, AccessTokenID: tokenID, AccessTokenHash: tokenHash,
		IssuedAt: now, ExpiresAt: now.Add(s.tokenTTL),
	})
	if err != nil {
		if reconciled, ok := s.reconcileCompletedLogin(ctx, state, tokenID, now); ok {
			return CompleteLoginResult{
				Principal: reconciled.Principal, TokenID: reconciled.TokenID,
				AccessToken: rawToken, ExpiresAt: reconciled.ExpiresAt,
			}, nil
		}
		return CompleteLoginResult{}, s.failSession(ctx, claim.Session, claimID, "persistence", err)
	}
	return CompleteLoginResult{
		Principal: completed.Principal, TokenID: completed.TokenID,
		AccessToken: rawToken, ExpiresAt: completed.ExpiresAt,
	}, nil
}

func (s *Service) reconcileCompletedLogin(
	ctx context.Context,
	state string,
	tokenID string,
	now time.Time,
) (CompletedLogin, bool) {
	claim, err := s.repository.ClaimSession(ctx, credentials.HashToken(state), s.newID(), now)
	if err != nil || claim.Disposition != ClaimCompleted || claim.Completed.TokenID != tokenID {
		return CompletedLogin{}, false
	}
	return claim.Completed, true
}

func (s *Service) failSession(
	ctx context.Context,
	session AuthSession,
	claimID string,
	stage string,
	cause error,
) error {
	command := FailSessionCommand{
		SessionID: session.ID, ClaimID: claimID, Stage: stage,
		Reason: "OIDC " + stage + " failed", FailedAt: s.now().UTC(),
	}
	failureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), failurePersistenceTimeout)
	defer cancel()
	if err := s.repository.FailSession(failureCtx, command); err != nil {
		return errors.Join(fmt.Errorf("OIDC %s failed", stage), fmt.Errorf("record terminal OIDC failure: %w", err))
	}
	if errors.Is(cause, domain.ErrInvalidArgument) {
		return cause
	}
	return domain.NewError("oidc_"+stage+"_failed", "OIDC login failed and must be restarted", false)
}

type sessionSecrets struct {
	Nonce        string `json:"nonce"`
	PKCEVerifier string `json:"pkce_verifier"`
}

func sealSessionSecrets(box *credentials.SecretBox, sessionID string, value sessionSecrets) (credentials.SealedSecret, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return credentials.SealedSecret{}, fmt.Errorf("encode OIDC session secrets: %w", err)
	}
	sealed, err := box.Seal(encoded, sessionID)
	if err != nil {
		return credentials.SealedSecret{}, fmt.Errorf("seal OIDC session secrets: %w", err)
	}
	return sealed, nil
}

func openSessionSecrets(box *credentials.SecretBox, sessionID string, sealed credentials.SealedSecret) (sessionSecrets, error) {
	encoded, err := box.Open(sealed, sessionID)
	if err != nil {
		return sessionSecrets{}, fmt.Errorf("open OIDC session secrets: %w", err)
	}
	var value sessionSecrets
	if err := json.Unmarshal(encoded, &value); err != nil {
		return sessionSecrets{}, fmt.Errorf("decode OIDC session secrets: %w", err)
	}
	if value.Nonce == "" || value.PKCEVerifier == "" {
		return sessionSecrets{}, fmt.Errorf("OIDC session secrets are incomplete")
	}
	return value, nil
}

func validateIdentity(provider Provider, identity VerifiedIdentity) (VerifiedIdentity, error) {
	issuer, err := normalizeHTTPURL(identity.Issuer, "identity issuer", true)
	if err != nil || issuer != provider.Issuer {
		return VerifiedIdentity{}, fmt.Errorf("verified identity issuer does not match provider")
	}
	identity.Subject = strings.TrimSpace(identity.Subject)
	if identity.Subject == "" {
		return VerifiedIdentity{}, fmt.Errorf("verified identity subject is required")
	}
	if !identity.EmailVerified {
		return VerifiedIdentity{}, fmt.Errorf("OIDC email must be verified")
	}
	identity.Email, err = domain.NormalizeEmail(identity.Email)
	if err != nil {
		return VerifiedIdentity{}, fmt.Errorf("verified identity email: %w", err)
	}
	identity.DisplayName = strings.TrimSpace(identity.DisplayName)
	if identity.DisplayName == "" {
		identity.DisplayName = identity.Email
	}
	identity.DisplayName, err = domain.NormalizeDisplayName(identity.DisplayName)
	if err != nil {
		return VerifiedIdentity{}, err
	}
	identity.Issuer = issuer
	return identity, nil
}

func normalizeHTTPURL(raw, field string, stripTrailingSlash bool) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.User != nil || parsed.Fragment != "" {
		return "", fmt.Errorf("%s must be an absolute HTTP URL", field)
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1" {
		return "", fmt.Errorf("%s must use HTTPS outside loopback", field)
	}
	if stripTrailingSlash {
		parsed.Path = strings.TrimRight(parsed.Path, "/")
	}
	return parsed.String(), nil
}

func validateDiscovery(discovery Discovery) error {
	for name, value := range map[string]string{
		"authorization endpoint": discovery.AuthorizationEndpoint,
		"token endpoint":         discovery.TokenEndpoint,
		"JWKS URI":               discovery.JWKSURI,
	} {
		if _, err := normalizeHTTPURL(value, name, false); err != nil {
			return err
		}
	}
	if discovery.UserInfoEndpoint != "" {
		if _, err := normalizeHTTPURL(discovery.UserInfoEndpoint, "userinfo endpoint", false); err != nil {
			return err
		}
	}
	return nil
}

func normalizeScopes(input []string) []string {
	seen := map[string]struct{}{"email": {}, "openid": {}}
	for _, value := range input {
		if scope := strings.TrimSpace(value); scope != "" {
			seen[scope] = struct{}{}
		}
	}
	result := make([]string, 0, len(seen))
	for scope := range seen {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result
}

func providerSecretAAD(organizationID, providerName string) string {
	return "oidc-provider\x00" + organizationID + "\x00" + providerName
}

func pkceChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
