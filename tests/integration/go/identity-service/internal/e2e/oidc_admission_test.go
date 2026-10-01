package e2e

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcclient"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func TestOIDCCompletionDeadline(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, test := range []struct {
		name   string
		delay  time.Duration
		atSave bool
	}{
		{name: "before_deadline", delay: 59 * time.Second},
		{name: "at_deadline", delay: time.Minute},
		{name: "after_deadline", delay: 61 * time.Second},
		{name: "persistence_rechecks_deadline", delay: time.Minute, atSave: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOIDCAdmissionFixture(t, databaseURL)
			if test.atSave {
				fixture.repository.beforeCompletion = func() { fixture.advance(test.delay) }
			} else {
				fixture.federation.afterExchange = func() { fixture.advance(test.delay) }
			}
			input := fixture.start(t)
			result, err := fixture.flow.CompleteLogin(t.Context(), input)
			var status, failureStage string
			var tokens, links, completedEvents int
			if queryErr := fixture.pool.QueryRow(t.Context(), `
				SELECT status, COALESCE(failure_stage, ''),
				       (SELECT count(*) FROM api_tokens),
				       (SELECT count(*) FROM external_identities),
				       (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')
				FROM oidc_auth_sessions`).Scan(&status, &failureStage, &tokens, &links, &completedEvents); queryErr != nil {
				t.Fatal(queryErr)
			}
			if test.delay < time.Minute {
				if err != nil || result.AccessToken == "" || status != "completed" || tokens != 1 || links != 1 || completedEvents != 1 {
					t.Fatalf("timely completion: status=%s tokens=%d links=%d events=%d error=%v", status, tokens, links, completedEvents, err)
				}
				fixture.advance(time.Minute)
				replay, replayErr := fixture.flow.CompleteLogin(t.Context(), input)
				if replayErr != nil || !replay.AlreadyCompleted || replay.AccessToken != "" || replay.TokenID != result.TokenID {
					t.Fatalf("completed metadata replay after login deadline: %v", replayErr)
				}
			} else {
				code, _, _ := domain.ErrorDetails(err)
				if code != "oidc_session_expired" || result.AccessToken != "" || status != "failed" || failureStage != "expired" || tokens != 0 || links != 0 || completedEvents != 0 {
					t.Fatalf("expired completion: status=%s stage=%s tokens=%d links=%d events=%d error=%v", status, failureStage, tokens, links, completedEvents, err)
				}
				_, replayErr := fixture.flow.CompleteLogin(t.Context(), input)
				if code, _, _ := domain.ErrorDetails(replayErr); code != "oidc_session_failed" {
					t.Fatalf("failed session retry: %v", replayErr)
				}
			}
			if fixture.idp.ExchangeCount() != 1 {
				t.Fatalf("exchange count=%d, want 1", fixture.idp.ExchangeCount())
			}
		})
	}
}

func TestOIDCProviderClientIDCannotChangeInPlace(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	fixture := newOIDCAdmissionFixture(t, databaseURL)
	if _, err := fixture.flow.CompleteLogin(t.Context(), fixture.start(t)); err != nil {
		t.Fatal(err)
	}
	provider, err := fixture.store.OIDC().FindProvider(t.Context(), fixture.admin.Organization.ID, "workforce")
	if err != nil {
		t.Fatal(err)
	}
	fixture.providerInput.ClientID = "different-registration"
	_, err = fixture.flow.UpsertProvider(t.Context(), fixture.providerInput)
	if code, _, _ := domain.ErrorDetails(err); code != "oidc_provider_client_id_immutable" {
		t.Fatalf("service accepted changed Client ID: %v", err)
	}
	changed := provider
	changed.ClientID = "different-registration"
	changed.Revision++
	_, err = fixture.store.OIDC().UpsertProvider(t.Context(), oidcflow.UpsertProviderCommand{
		ActorPrincipalID: fixture.admin.User.ID, RequestID: "stale-registration", Provider: changed,
	})
	if code, _, _ := domain.ErrorDetails(err); code != "oidc_provider_client_id_immutable" {
		t.Fatalf("persistence accepted changed Client ID: %v", err)
	}
	stored, err := fixture.store.OIDC().GetProvider(t.Context(), provider.ID)
	if err != nil || stored.ClientID != provider.ClientID || stored.Revision != provider.Revision {
		t.Fatalf("rejected update mutated Provider: %v", err)
	}
	fixture.providerInput.ClientID = provider.ClientID
	fixture.providerInput.ClientSecret = "rotated-secret"
	rotated, err := fixture.flow.UpsertProvider(t.Context(), fixture.providerInput)
	if err != nil || rotated.ID != provider.ID || rotated.Revision != provider.Revision+1 {
		t.Fatalf("secret rotation failed: %v", err)
	}
	fixture.idp.mu.Lock()
	fixture.idp.clientSecret = "rotated-secret"
	fixture.idp.mu.Unlock()
	if _, err := fixture.flow.CompleteLogin(t.Context(), fixture.start(t)); err != nil {
		t.Fatalf("login after secret rotation: %v", err)
	}
	var links, events int
	if err := fixture.pool.QueryRow(t.Context(), `
		SELECT (SELECT count(*) FROM external_identities),
		       (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_provider.upserted')`).Scan(&links, &events); err != nil {
		t.Fatal(err)
	}
	if links != 1 || events != 2 {
		t.Fatalf("registration links=%d provider writes=%d, want 1/2", links, events)
	}
}

type oidcAdmissionFixture struct {
	localAdmissionFixture
	flow          *oidcflow.Service
	idp           *oidcProvider
	federation    *delayedFederation
	repository    *delayedOIDCRepository
	now           atomic.Int64
	providerInput oidcflow.UpsertProviderInput
}

func newOIDCAdmissionFixture(t *testing.T, databaseURL string) *oidcAdmissionFixture {
	t.Helper()
	f := &oidcAdmissionFixture{}
	f.now.Store(time.Now().UnixNano())
	f.localAdmissionFixture = newLocalAdmissionFixture(t, databaseURL, f.time)
	f.idp = newOIDCProvider(t)
	f.idp.email = "member@example.com"
	t.Cleanup(f.idp.Close)
	client, err := oidcclient.New(f.idp.Client())
	if err != nil {
		t.Fatal(err)
	}
	f.federation = &delayedFederation{Federation: client}
	f.repository = &delayedOIDCRepository{Repository: f.store.OIDC()}
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	f.flow, err = oidcflow.NewService(oidcflow.Config{
		Repository: f.repository, Federation: f.federation, SecretBox: box,
		NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.time,
		RedirectURI: "https://identity.test/protocol/oidc/callback", SessionTTL: time.Minute, TokenTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.providerInput = oidcflow.UpsertProviderInput{
		RequestID: "provider", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
		Name: "workforce", Issuer: f.idp.URL, ClientID: "client-1", ClientSecret: "client-secret", Enabled: true,
	}
	if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *oidcAdmissionFixture) start(t *testing.T) oidcflow.CompleteLoginInput {
	t.Helper()
	started, err := f.flow.StartLogin(t.Context(), oidcflow.StartLoginInput{
		RequestID: f.newID("request"), OrganizationSlug: "admission", ProviderName: "workforce",
	})
	if err != nil {
		t.Fatal(err)
	}
	client := *f.idp.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, started.AuthorizationURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	callback, err := response.Location()
	if err != nil || response.StatusCode != http.StatusFound {
		t.Fatalf("authorization redirect: status=%d error=%v", response.StatusCode, err)
	}
	return oidcflow.CompleteLoginInput{State: callback.Query().Get("state"), Code: callback.Query().Get("code")}
}

type delayedFederation struct {
	oidcflow.Federation
	afterExchange func()
}

func (f *delayedFederation) ExchangeAndVerify(ctx context.Context, input oidcflow.ExchangeInput) (oidcflow.VerifiedIdentity, error) {
	identity, err := f.Federation.ExchangeAndVerify(ctx, input)
	if f.afterExchange != nil {
		f.afterExchange()
	}
	return identity, err
}

type delayedOIDCRepository struct {
	oidcflow.Repository
	beforeCompletion func()
}

func (r *delayedOIDCRepository) CompleteLogin(ctx context.Context, command oidcflow.CompleteLoginCommand) (oidcflow.CompletedLogin, error) {
	if r.beforeCompletion != nil {
		r.beforeCompletion()
	}
	return r.Repository.CompleteLogin(ctx, command)
}

func (f *oidcAdmissionFixture) time() time.Time { return time.Unix(0, f.now.Load()).UTC() }

func (f *oidcAdmissionFixture) advance(delay time.Duration) { f.now.Add(int64(delay)) }
