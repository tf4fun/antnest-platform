package oidcflow

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type browserOIDCRepository struct {
	*oidcRepositoryStub
	persisted     CompletedLogin
	afterClaim    func(int)
	afterComplete func()
}

func (r *browserOIDCRepository) ClaimSession(ctx context.Context, hash, claimID string, now time.Time) (SessionClaim, error) {
	claim, err := r.oidcRepositoryStub.ClaimSession(ctx, hash, claimID, now)
	if r.afterClaim != nil {
		r.afterClaim(r.claimCalls)
	}
	return claim, err
}

func (r *browserOIDCRepository) CompleteLogin(_ context.Context, command CompleteLoginCommand) (CompletedLogin, error) {
	r.completed = command
	r.persisted.SessionID, r.persisted.TokenID = command.SessionID, command.AccessTokenID
	if r.completeCommits {
		r.claim = SessionClaim{Disposition: ClaimCompleted, Completed: r.persisted}
	}
	if r.afterComplete != nil {
		r.afterComplete()
	}
	if r.completeErr != nil {
		return CompletedLogin{}, r.completeErr
	}
	return r.persisted, nil
}

func browserOIDCService(t *testing.T) (*Service, *browserOIDCRepository, *federationStub) {
	t.Helper()
	base := newOIDCRepositoryStub(t)
	base.provider = testProvider(t)
	base.claim = SessionClaim{Disposition: ClaimAcquired, Session: testSession(t)}
	repository := &browserOIDCRepository{oidcRepositoryStub: base, persisted: testCompletedLogin()}
	repository.persisted.ExpiresAt = fixedOIDCNow().Add(57 * time.Minute)
	repository.persisted.IdleExpiresAt = fixedOIDCNow().Add(5 * time.Second)
	repository.persisted.ActivityIntervalMS = 1666
	federation := &federationStub{identity: VerifiedIdentity{Issuer: "https://id.example.com", Subject: "subject-1", Email: "alice@example.com", EmailVerified: true, DisplayName: "Alice"}}
	service := newTestService(t, base, federation)
	service.repository = repository
	return service, repository, federation
}

func TestOIDCBrowserStartPersistsOnlyBoundedDisplayHint(t *testing.T) {
	for _, length := range []int{0, 256, 257} {
		t.Run(strconv.Itoa(length), func(t *testing.T) {
			service, repository, _ := browserOIDCService(t)
			hint := strings.Repeat("界", length)
			_, err := service.StartLogin(t.Context(), StartLoginInput{RequestID: "start", OrganizationSlug: "engineering", ProviderName: "workforce", UserAgentHint: hint})
			if length > 256 {
				if !errors.Is(err, domain.ErrInvalidArgument) || repository.session.Session.ID != "" {
					t.Fatalf("oversized OIDC hint persisted=%t error=%v", repository.session.Session.ID != "", err)
				}
			} else if err != nil || repository.session.Session.UserAgentHint != hint {
				t.Fatalf("OIDC start lost its bounded display hint: %v", err)
			}
		})
	}
}

func TestOIDCBrowserResponsesProjectPersistedDeadlines(t *testing.T) {
	for _, mode := range []string{"initial", "replay", "reconciliation"} {
		t.Run(mode, func(t *testing.T) {
			service, repository, federation := browserOIDCService(t)
			if mode == "replay" {
				repository.claim = SessionClaim{Disposition: ClaimCompleted, Completed: repository.persisted}
			}
			if mode == "reconciliation" {
				repository.completeErr, repository.completeCommits = errors.New("commit acknowledgement lost"), true
			}
			result, err := service.CompleteLogin(t.Context(), CompleteLoginInput{State: "state", Code: "code"})
			if err != nil {
				t.Fatal(err)
			}
			if result.TokenID != repository.persisted.TokenID || result.Principal != repository.persisted.Principal || !result.ExpiresAt.Equal(repository.persisted.ExpiresAt) || !result.IdleExpiresAt.Equal(repository.persisted.IdleExpiresAt) || result.ActivityIntervalMS != 1666 {
				t.Fatal("OIDC response lost the persisted browser-session snapshot")
			}
			if mode == "replay" {
				if result.AccessToken != "" || !result.AlreadyCompleted || federation.exchangeCalls != 0 {
					t.Fatal("ordinary completed replay issued a credential or repeated the exchange")
				}
			} else if result.AccessToken == "" || result.AlreadyCompleted || federation.exchangeCalls != 1 || credentials.HashToken(result.AccessToken) != repository.completed.AccessTokenHash {
				t.Fatal("original issuance lost its credential or exchanged more than once")
			}
			if mode == "reconciliation" && repository.claimCalls != 2 {
				t.Fatal("ambiguous commit did not re-read its own completed session")
			}
		})
	}
}

func TestOIDCBrowserReconciliationCannotRecoverAnotherOrInactiveSession(t *testing.T) {
	for _, invalid := range []string{"different-token", "inactive"} {
		t.Run(invalid, func(t *testing.T) {
			service, repository, federation := browserOIDCService(t)
			repository.completeErr, repository.completeCommits = errors.New("commit acknowledgement lost"), true
			repository.afterComplete = func() {
				if invalid == "different-token" {
					repository.claim.Completed.TokenID = "another-operation-token"
				} else {
					repository.claim.Completed.Principal.Active = false
				}
			}
			result, err := service.CompleteLogin(t.Context(), CompleteLoginInput{State: "state", Code: "code"})
			if err == nil || result.AccessToken != "" || result.TokenID != "" || repository.claimCalls != 2 || federation.exchangeCalls != 1 {
				t.Fatalf("invalid reconciliation returned authority or repeated exchange: %v", err)
			}
			if invalid == "inactive" {
				if code, _, _ := domain.ErrorDetails(err); code != "oidc_completed_token_unavailable" || repository.failed.SessionID != "" {
					t.Fatal("inactive completed reconciliation changed the workflow or hid its admission error")
				}
			}
		})
	}
}

func TestOIDCBrowserCompletedReplayRequiresCurrentAuthority(t *testing.T) {
	for _, invalid := range []string{"idle", "absolute", "inactive", "expires-during-claim"} {
		t.Run(invalid, func(t *testing.T) {
			service, repository, federation := browserOIDCService(t)
			now := fixedOIDCNow()
			service.now = func() time.Time { return now }
			switch invalid {
			case "idle":
				repository.persisted.IdleExpiresAt = now
			case "absolute":
				repository.persisted.ExpiresAt = now
			case "inactive":
				repository.persisted.Principal.Active = false
			case "expires-during-claim":
				repository.afterClaim = func(int) { now = repository.persisted.IdleExpiresAt }
			}
			repository.claim = SessionClaim{Disposition: ClaimCompleted, Completed: repository.persisted}
			result, err := service.CompleteLogin(t.Context(), CompleteLoginInput{State: "state", Code: "unused"})
			if code, _, _ := domain.ErrorDetails(err); code != "oidc_completed_token_unavailable" || result.TokenID != "" || result.AccessToken != "" {
				t.Fatalf("invalid completed authority returned a session: %v", err)
			}
			if federation.exchangeCalls != 0 || repository.failed.SessionID != "" {
				t.Fatal("expired completed replay changed the OIDC workflow or repeated the exchange")
			}
		})
	}
}

func TestOIDCBrowserInitialAndReconciledRepliesRecheckTimeAfterRepository(t *testing.T) {
	for _, mode := range []string{"initial", "reconciliation"} {
		for _, boundary := range []string{"idle", "absolute"} {
			t.Run(mode+"/"+boundary, func(t *testing.T) {
				service, repository, federation := browserOIDCService(t)
				now := fixedOIDCNow()
				service.now = func() time.Time { return now }
				deadline := repository.persisted.IdleExpiresAt
				if boundary == "absolute" {
					repository.persisted.ExpiresAt = deadline
					repository.persisted.IdleExpiresAt = now.Add(time.Hour)
				}
				if mode == "initial" {
					repository.afterComplete = func() { now = deadline }
				} else {
					repository.completeErr, repository.completeCommits = errors.New("commit acknowledgement lost"), true
					repository.afterClaim = func(calls int) {
						if calls == 2 {
							now = deadline
						}
					}
				}
				result, err := service.CompleteLogin(t.Context(), CompleteLoginInput{State: "state", Code: "code"})
				if code, _, _ := domain.ErrorDetails(err); code != "oidc_completed_token_unavailable" || result.AccessToken != "" || result.TokenID != "" {
					t.Fatalf("expired repository result returned a credential: %v", err)
				}
				if federation.exchangeCalls != 1 || repository.failed.SessionID != "" {
					t.Fatal("expired committed result changed workflow or repeated the exchange")
				}
			})
		}
	}
}
