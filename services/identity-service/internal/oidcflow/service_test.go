package oidcflow

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestUpsertProviderDiscoversBeforePersistingEnabledConfiguration(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	federation := &federationStub{discovery: Discovery{
		Issuer: "https://id.example.com/", AuthorizationEndpoint: "https://id.example.com/authorize",
		TokenEndpoint: "https://id.example.com/token", UserInfoEndpoint: "https://id.example.com/userinfo",
		JWKSURI:                  "https://id.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}}
	service := newTestService(t, repository, federation)

	provider, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		RequestID: "request-1", ActorPrincipalID: "admin", OrganizationID: "org-1",
		Name: " Workforce ", Issuer: "https://id.example.com/", ClientID: "client-1",
		ClientSecret: "top-secret", Scopes: []string{"profile"}, Enabled: true,
	})
	if err != nil {
		t.Fatalf("upsert provider: %v", err)
	}
	if provider.ID != "id-1" || provider.Name != "workforce" || !provider.Enabled {
		t.Fatalf("provider = %#v", provider)
	}
	if provider.Issuer != "https://id.example.com/" {
		t.Fatalf("provider issuer = %q, want exact configured issuer", provider.Issuer)
	}
	if repository.upsert.Provider.ClientSecret.Ciphertext == nil ||
		bytes.Contains(repository.upsert.Provider.ClientSecret.Ciphertext, []byte("top-secret")) {
		t.Fatal("client secret was not sealed")
	}
	if repository.upsert.Provider.AuthorizationEndpoint != federation.discovery.AuthorizationEndpoint {
		t.Fatal("discovery result was not persisted with provider")
	}
	if repository.upsert.Provider.TokenEndpointAuthMethod != "client_secret_basic" ||
		len(repository.upsert.Provider.IDTokenSigningAlgs) != 1 ||
		repository.upsert.Provider.IDTokenSigningAlgs[0] != "RS256" {
		t.Fatalf("Provider security metadata = %#v", repository.upsert.Provider.Provider)
	}
	if got := strings.Join(repository.upsert.Provider.Scopes, ","); got != "email,openid,profile" {
		t.Fatalf("provider scopes = %q, want mandatory email and openid scopes", got)
	}
	secret, err := service.secretBox.Open(
		repository.upsert.Provider.ClientSecret,
		providerSecretAAD(repository.upsert.Provider.OrganizationID, repository.upsert.Provider.Name),
	)
	if err != nil || string(secret) != "top-secret" {
		t.Fatalf("open Provider secret with stable identity: %q, %v", secret, err)
	}
}

func TestUpsertProviderRequiresSystemAdministrator(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = organizationAdmin()
	service := newTestService(t, repository, &federationStub{})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "organization-admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "https://id.example.com", ClientID: "client", ClientSecret: "secret",
	})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("organization administrator upsert error = %v, want forbidden", err)
	}
}

func TestUpsertProviderTreatsTrailingSlashAsPartOfIssuerIdentity(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	service := newTestService(t, repository, &federationStub{discovery: Discovery{
		Issuer: "https://id.example.com", AuthorizationEndpoint: "https://id.example.com/authorize",
		TokenEndpoint: "https://id.example.com/token", JWKSURI: "https://id.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "https://id.example.com/", ClientID: "client", ClientSecret: "secret",
	})
	if err == nil || repository.upsert.Provider.ID != "" {
		t.Fatalf("issuer mismatch err=%v write=%#v", err, repository.upsert)
	}
}

func TestOIDCUserControlledValidationReturnsInvalidArgument(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	service := newTestService(t, repository, &federationStub{})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "not-a-url", ClientID: "client", ClientSecret: "secret",
	})
	if !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatalf("invalid Provider error = %v, want invalid argument", err)
	}
	_, err = service.CompleteLogin(context.Background(), CompleteLoginInput{})
	if !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatalf("missing state error = %v, want invalid argument", err)
	}
}

func TestValidateIdentityPreservesOpaqueSubject(t *testing.T) {
	provider := testProvider(t).Provider
	identity := VerifiedIdentity{
		Issuer: provider.Issuer, Subject: " subject-1 ", Email: "alice@example.com",
		EmailVerified: true,
	}

	validated, err := validateIdentity(provider, identity)
	if err != nil {
		t.Fatalf("validate identity: %v", err)
	}
	if validated.Subject != identity.Subject {
		t.Fatalf("OIDC subject = %q, want exact opaque value %q", validated.Subject, identity.Subject)
	}
}

func TestUpsertProviderRejectsDiscoveryIssuerMismatchWithoutWrite(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	service := newTestService(t, repository, &federationStub{discovery: Discovery{
		Issuer: "https://attacker.example.com", AuthorizationEndpoint: "https://attacker.example.com/authorize",
		TokenEndpoint: "https://attacker.example.com/token", JWKSURI: "https://attacker.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "https://id.example.com", ClientID: "client", ClientSecret: "secret", Enabled: true,
	})
	if err == nil || repository.upsert.Provider.ID != "" {
		t.Fatalf("issuer mismatch err=%v write=%#v", err, repository.upsert)
	}
}

func TestUpsertProviderRejectsInsecureDiscoveredEndpoint(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	service := newTestService(t, repository, &federationStub{discovery: Discovery{
		Issuer: "https://id.example.com", AuthorizationEndpoint: "https://id.example.com/authorize",
		TokenEndpoint: "http://127.0.0.1/token", JWKSURI: "https://id.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "https://id.example.com", ClientID: "client", ClientSecret: "secret",
	})
	if err == nil || repository.upsert.Provider.ID != "" {
		t.Fatalf("insecure discovery endpoint err=%v write=%#v", err, repository.upsert)
	}
}

func TestUpsertProviderRejectsChangingExistingIssuer(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	repository.provider = testProvider(t)
	service := newTestService(t, repository, &federationStub{discovery: Discovery{
		Issuer: "https://replacement.example.com", AuthorizationEndpoint: "https://replacement.example.com/authorize",
		TokenEndpoint: "https://replacement.example.com/token", JWKSURI: "https://replacement.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}})

	_, err := service.UpsertProvider(context.Background(), UpsertProviderInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce",
		Issuer: "https://replacement.example.com", ClientID: "client", ClientSecret: "secret", Enabled: true,
	})
	code, message, _ := domain.ErrorDetails(err)
	if code != "oidc_provider_issuer_immutable" ||
		!strings.Contains(message, "new Provider name") || repository.upsert.Provider.ID != "" {
		t.Fatalf("issuer change err=%v code=%q message=%q write=%#v", err, code, message, repository.upsert)
	}
}

func TestSetProviderEnabledDoesNotDependOnExternalDiscovery(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	repository.provider = testProvider(t)
	federation := &federationStub{discoveryErr: errors.New("provider is retired")}
	service := newTestService(t, repository, federation)

	provider, err := service.SetProviderEnabled(context.Background(), SetProviderEnabledInput{
		RequestID: "request-disable", ActorPrincipalID: "admin", OrganizationID: "org-1",
		Name: " Workforce ", Enabled: false,
	})
	if err != nil {
		t.Fatalf("disable Provider: %v", err)
	}
	if provider.Enabled || repository.setEnabled.Name != "workforce" || repository.setEnabled.Enabled {
		t.Fatalf("Provider=%#v command=%#v", provider, repository.setEnabled)
	}
	if federation.discoveryCalls != 0 {
		t.Fatalf("disable Provider made %d discovery calls", federation.discoveryCalls)
	}
}

func TestStartLoginStoresHashedStateAndSealedPKCESecrets(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	federation := &federationStub{}
	service := newTestService(t, repository, federation)

	login, err := service.StartLogin(context.Background(), StartLoginInput{
		RequestID: "request-1", OrganizationSlug: "engineering", ProviderName: "workforce",
	})
	if err != nil {
		t.Fatalf("start login: %v", err)
	}
	if login.AuthorizationURL == "" || login.ExpiresAt != fixedOIDCNow().Add(10*time.Minute) {
		t.Fatalf("login = %#v", login)
	}
	if repository.session.StateHash == "" || strings.Contains(repository.session.StateHash, "oidc_state_") {
		t.Fatal("raw state was persisted")
	}
	if len(repository.session.Session.Secrets.Ciphertext) == 0 || repository.session.Session.Secrets.Nonce == nil {
		t.Fatal("OIDC session secrets were not sealed")
	}
	if federation.authorization.PKCEChallenge == "" || federation.authorization.State == "" ||
		federation.authorization.Nonce == "" {
		t.Fatalf("authorization input = %#v", federation.authorization)
	}
	if federation.authorization.RedirectURI != "https://antnest.example.com/protocol/oidc/callback" ||
		repository.session.Session.ProviderRevision != repository.provider.Revision {
		t.Fatalf("authorization=%#v session=%#v", federation.authorization, repository.session.Session)
	}
}

func TestCompleteLoginRejectsProviderChangedAfterAuthorizationStarted(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.provider.Revision++
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	service := newTestService(t, repository, &federationStub{})

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	code, _, _ := domain.ErrorDetails(err)
	if code != "oidc_provider_changed" || repository.failed.Stage != "provider" {
		t.Fatalf("provider change error=%v code=%q failure=%#v", err, code, repository.failed)
	}
}

func TestCompleteLoginClaimsBeforeExchangeAndPersistsHashedCredential(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	federation := &federationStub{identity: VerifiedIdentity{
		Issuer: "https://id.example.com", Subject: "subject-1", Email: "Alice@Example.COM",
		EmailVerified: true, DisplayName: "Alice",
	}}
	service := newTestService(t, repository, federation)

	result, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	if err != nil {
		t.Fatalf("complete login: %v", err)
	}
	if !repository.claimedBeforeExchange || federation.exchangeCalls != 1 {
		t.Fatal("authorization code was exchanged before durable session claim")
	}
	if repository.completed.Identity.Email != "alice@example.com" ||
		repository.completed.AccessTokenHash != credentials.HashToken(result.AccessToken) ||
		repository.completed.AccessTokenHash == result.AccessToken {
		t.Fatalf("completion = %#v", repository.completed)
	}
	if result.Principal.UserID != "user-1" || result.AccessToken == "" {
		t.Fatalf("result = %#v", result)
	}
	if result.TokenID == "" || result.AlreadyCompleted {
		t.Fatalf("initial completion metadata = %#v", result)
	}
}

func TestCompleteLoginReplayNeverReturnsCredentialOrExchangesAgain(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	replay := testCompletedLogin()
	repository.claim = SessionClaim{Disposition: ClaimCompleted, Completed: replay}
	federation := &federationStub{}
	service := newTestService(t, repository, federation)

	result, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "ignored-on-replay",
	})
	if err != nil {
		t.Fatalf("replay login: %v", err)
	}
	if result.AccessToken != "" || result.TokenID != replay.TokenID || !result.AlreadyCompleted || federation.exchangeCalls != 0 {
		t.Fatalf("replay result=%#v exchange calls=%d", result, federation.exchangeCalls)
	}
}

func TestCompleteLoginTerminalizesExchangeFailure(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	const sensitiveProviderResponse = "access_token=must-not-be-persisted"
	federation := &federationStub{exchangeErr: errors.New("provider unavailable: " + sensitiveProviderResponse)}
	service := newTestService(t, repository, federation)

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	if err == nil || repository.failed.SessionID == "" || repository.failed.Stage != "exchange" {
		t.Fatalf("exchange error=%v failure=%#v", err, repository.failed)
	}
	if strings.Contains(repository.failed.Reason, sensitiveProviderResponse) {
		t.Fatalf("failure reason persisted sensitive provider response: %q", repository.failed.Reason)
	}
	if repository.failed.Reason != "OIDC exchange failed" {
		t.Fatalf("failure reason = %q, want stable stage summary", repository.failed.Reason)
	}
}

func TestCompleteLoginBoundsFailurePersistenceAfterCallerCancellation(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	service := newTestService(t, repository, &federationStub{exchangeErr: errors.New("provider unavailable")})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := service.CompleteLogin(ctx, CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	if err == nil {
		t.Fatal("expected OIDC exchange failure")
	}
	if repository.failureContextErr != nil {
		t.Fatalf("failure persistence inherited caller cancellation: %v", repository.failureContextErr)
	}
	if !repository.failureContextHasDeadline {
		t.Fatal("failure persistence has no deadline")
	}
	remaining := time.Until(repository.failureContextDeadline)
	if remaining < 4*time.Second || remaining > failurePersistenceTimeout {
		t.Fatalf("failure persistence deadline remaining = %s, want approximately %s", remaining, failurePersistenceTimeout)
	}
}

func TestCompleteLoginTerminalizesMissingCodeAsInvalidArgument(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	service := newTestService(t, repository, &federationStub{})

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{State: "oidc_state_2"})
	if !errors.Is(err, domain.ErrInvalidArgument) || repository.failed.Stage != "authorization" {
		t.Fatalf("missing code error=%v failure=%#v", err, repository.failed)
	}
}

func TestCompleteLoginTerminalizesProviderAuthorizationErrorWithoutExchange(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	federation := &federationStub{}
	service := newTestService(t, repository, federation)

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", AuthorizationError: "access_denied",
	})
	code, _, _ := domain.ErrorDetails(err)
	if code != "oidc_authorization_failed" || repository.failed.Stage != "authorization" {
		t.Fatalf("authorization error=%v code=%q failure=%#v", err, code, repository.failed)
	}
	if federation.exchangeCalls != 0 {
		t.Fatalf("authorization error performed %d token exchanges", federation.exchangeCalls)
	}
}

func TestCompleteLoginTerminalizesPersistenceFailure(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	repository.completeErr = errors.New("database unavailable")
	federation := &federationStub{identity: VerifiedIdentity{
		Issuer: "https://id.example.com", Subject: "subject-1", Email: "alice@example.com",
		EmailVerified: true, DisplayName: "Alice",
	}}
	service := newTestService(t, repository, federation)

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	if err == nil || repository.failed.Stage != "persistence" {
		t.Fatalf("persistence error=%v failure=%#v", err, repository.failed)
	}
}

func TestCompleteLoginClassifiesCommitTimeProviderChange(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	repository.completeErr = domain.NewError("oidc_provider_changed", "OIDC Provider changed", false)
	federation := &federationStub{identity: VerifiedIdentity{
		Issuer: "https://id.example.com", Subject: "subject-1", Email: "alice@example.com",
		EmailVerified: true, DisplayName: "Alice",
	}}
	service := newTestService(t, repository, federation)

	_, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	code, _, _ := domain.ErrorDetails(err)
	if code != "oidc_provider_changed" || repository.failed.Stage != "provider" {
		t.Fatalf("commit-time Provider change error=%v code=%q failure=%#v", err, code, repository.failed)
	}
}

func TestCompleteLoginRecoversAnAmbiguousSuccessfulCommit(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.provider = testProvider(t)
	repository.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	repository.completeErr = errors.New("commit result unavailable")
	repository.completeCommits = true
	federation := &federationStub{identity: VerifiedIdentity{
		Issuer: "https://id.example.com", Subject: "subject-1", Email: "alice@example.com",
		EmailVerified: true, DisplayName: "Alice",
	}}
	service := newTestService(t, repository, federation)

	result, err := service.CompleteLogin(context.Background(), CompleteLoginInput{
		State: "oidc_state_2", Code: "authorization-code",
	})
	if err != nil || result.AccessToken == "" || result.TokenID == "" || repository.failed.SessionID != "" {
		t.Fatalf("ambiguous completion result=%#v err=%v failure=%#v", result, err, repository.failed)
	}
	if repository.claimCalls != 2 {
		t.Fatalf("claim calls = %d, want initial claim plus reconciliation", repository.claimCalls)
	}
}

type oidcRepositoryStub struct {
	t                         *testing.T
	principal                 domain.Principal
	provider                  ProviderWithSecret
	upsert                    UpsertProviderCommand
	setEnabled                SetProviderEnabledCommand
	session                   CreateSessionCommand
	claim                     SessionClaim
	completed                 CompleteLoginCommand
	completeErr               error
	completeCommits           bool
	failed                    FailSessionCommand
	failureContextErr         error
	failureContextHasDeadline bool
	failureContextDeadline    time.Time
	claimedBeforeExchange     bool
	claimCalls                int
}

func newOIDCRepositoryStub(t *testing.T) *oidcRepositoryStub { return &oidcRepositoryStub{t: t} }

func (r *oidcRepositoryStub) GetPrincipal(context.Context, string, string) (domain.Principal, error) {
	return r.principal, nil
}

func (r *oidcRepositoryStub) FindProvider(context.Context, string, string) (ProviderWithSecret, error) {
	if r.provider.ID == "" {
		return ProviderWithSecret{}, domain.ErrNotFound
	}
	return r.provider, nil
}

func (r *oidcRepositoryStub) FindLoginProvider(context.Context, string, string) (ProviderWithSecret, error) {
	if r.provider.ID == "" {
		return ProviderWithSecret{}, domain.ErrNotFound
	}
	return r.provider, nil
}

func (r *oidcRepositoryStub) GetProvider(context.Context, string) (ProviderWithSecret, error) {
	if r.provider.ID == "" {
		return ProviderWithSecret{}, domain.ErrNotFound
	}
	return r.provider, nil
}

func (r *oidcRepositoryStub) UpsertProvider(_ context.Context, command UpsertProviderCommand) (Provider, error) {
	r.upsert = command
	return command.Provider.Provider, nil
}

func (r *oidcRepositoryStub) SetProviderEnabled(
	_ context.Context,
	command SetProviderEnabledCommand,
) (Provider, error) {
	r.setEnabled = command
	provider := r.provider.Provider
	provider.Enabled = command.Enabled
	provider.UpdatedAt = command.UpdatedAt
	return provider, nil
}

func (r *oidcRepositoryStub) ListLoginMethods(context.Context, string) ([]LoginMethod, error) {
	return []LoginMethod{{Name: "workforce", DisplayName: "Workforce"}}, nil
}

func (r *oidcRepositoryStub) CreateSession(_ context.Context, command CreateSessionCommand) error {
	r.session = command
	return nil
}

func (r *oidcRepositoryStub) ClaimSession(_ context.Context, _ string, _ string, _ time.Time) (SessionClaim, error) {
	r.claimCalls++
	r.claimedBeforeExchange = true
	return r.claim, nil
}

func (r *oidcRepositoryStub) CompleteLogin(_ context.Context, command CompleteLoginCommand) (CompletedLogin, error) {
	r.completed = command
	committed := CompletedLogin{
		SessionID: command.SessionID, TokenID: command.AccessTokenID, ExpiresAt: command.ExpiresAt,
		Principal: domain.Principal{UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1", Active: true},
	}
	if r.completeCommits {
		r.claim = SessionClaim{Disposition: ClaimCompleted, Completed: committed}
	}
	if r.completeErr != nil {
		return CompletedLogin{}, r.completeErr
	}
	return committed, nil
}

func (r *oidcRepositoryStub) FailSession(ctx context.Context, command FailSessionCommand) error {
	r.failed = command
	r.failureContextErr = ctx.Err()
	r.failureContextDeadline, r.failureContextHasDeadline = ctx.Deadline()
	return nil
}

type federationStub struct {
	discovery      Discovery
	discoveryErr   error
	discoveryCalls int
	authorization  AuthorizationInput
	identity       VerifiedIdentity
	exchangeErr    error
	exchangeCalls  int
	repository     *oidcRepositoryStub
}

func (f *federationStub) Discover(context.Context, string) (Discovery, error) {
	f.discoveryCalls++
	return f.discovery, f.discoveryErr
}

func (f *federationStub) AuthorizationURL(input AuthorizationInput) (string, error) {
	f.authorization = input
	values := url.Values{"state": {input.State}, "nonce": {input.Nonce}, "code_challenge": {input.PKCEChallenge}}
	return input.Provider.AuthorizationEndpoint + "?" + values.Encode(), nil
}

func (f *federationStub) ExchangeAndVerify(context.Context, ExchangeInput) (VerifiedIdentity, error) {
	f.exchangeCalls++
	if f.repository != nil && !f.repository.claimedBeforeExchange {
		f.repository.t.Fatal("exchange happened before claim")
	}
	return f.identity, f.exchangeErr
}

func newTestService(t *testing.T, repository *oidcRepositoryStub, federation *federationStub) *Service {
	t.Helper()
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatalf("new secret box: %v", err)
	}
	federation.repository = repository
	next := 0
	service, err := NewService(Config{
		Repository: repository, Federation: federation, SecretBox: box,
		NewID:     func() string { next++; return fmt.Sprintf("id-%d", next) },
		NewOpaque: deterministicOpaque(), Now: fixedOIDCNow,
		RedirectURI: "https://antnest.example.com/protocol/oidc/callback",
		SessionTTL:  10 * time.Minute, TokenTTL: 12 * time.Hour,
	})
	if err != nil {
		t.Fatalf("new OIDC service: %v", err)
	}
	return service
}

func deterministicOpaque() func(string) (string, string, error) {
	next := 0
	return func(prefix string) (string, string, error) {
		next++
		raw := fmt.Sprintf("%s%d", prefix, next)
		return raw, credentials.HashToken(raw), nil
	}
}

func organizationAdmin() domain.Principal {
	return domain.Principal{
		UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-admin",
		SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleAdmin, Active: true,
	}
}

func systemAdministrator() domain.Principal {
	return domain.Principal{UserID: "admin", SystemRole: domain.SystemRoleAdmin, Active: true}
}

func testProvider(t *testing.T) ProviderWithSecret {
	t.Helper()
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	secret, err := box.Seal([]byte("client-secret"), providerSecretAAD("org-1", "workforce"))
	if err != nil {
		t.Fatal(err)
	}
	return ProviderWithSecret{Provider: Provider{
		ID: "provider-1", OrganizationID: "org-1", Name: "workforce", DisplayName: "Workforce",
		Issuer: "https://id.example.com", ClientID: "client-1", ClientSecret: secret, Revision: 1,
		Scopes: []string{"openid", "profile", "email"}, Enabled: true,
		AuthorizationEndpoint: "https://id.example.com/authorize",
		TokenEndpoint:         "https://id.example.com/token", TokenEndpointAuthMethod: "client_secret_basic",
		IDTokenSigningAlgs: []string{"RS256"}, UserInfoEndpoint: "https://id.example.com/userinfo",
		JWKSURI: "https://id.example.com/jwks",
	}}
}

func testSession(t *testing.T) AuthSession {
	t.Helper()
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealSessionSecrets(box, "session-1", sessionSecrets{Nonce: "oidc_nonce_3", PKCEVerifier: "oidc_pkce_4"})
	if err != nil {
		t.Fatal(err)
	}
	return AuthSession{
		ID: "session-1", ProviderID: "provider-1", OrganizationID: "org-1",
		ProviderRevision: 1, Status: SessionStatusExchanging, Secrets: sealed,
		ExpiresAt: fixedOIDCNow().Add(10 * time.Minute),
	}
}

func testCompletedLogin() CompletedLogin {
	return CompletedLogin{
		SessionID: "session-1", TokenID: "token-1", ExpiresAt: fixedOIDCNow().Add(12 * time.Hour),
		Principal: domain.Principal{UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1", Active: true},
	}
}

func fixedOIDCNow() time.Time { return time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC) }
