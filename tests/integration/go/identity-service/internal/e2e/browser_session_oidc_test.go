package e2e

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func browserOIDCFixture(t *testing.T) *oidcAdmissionFixture {
	t.Helper()
	return browserOIDCFixtureWithTokenTTL(t, time.Hour)
}

func browserOIDCFixtureWithTokenTTL(t *testing.T, tokenTTL time.Duration) *oidcAdmissionFixture {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	return newOIDCAdmissionFixtureWithTokenTTL(t, databaseURL, tokenTTL)
}

func TestOIDCBrowserLoginPersistsHintAndDeadlinesWithoutReplayActivity(t *testing.T) {
	f := browserOIDCFixture(t)
	if err := f.store.InitializeBrowserSessions(t.Context(), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	hint := strings.Repeat("界", 256)
	input := f.startWithHint(t, hint)
	var workflowHint string
	if err := f.pool.QueryRow(t.Context(), `SELECT user_agent_hint FROM oidc_auth_sessions WHERE state_hash = $1`, credentials.HashToken(input.State)).Scan(&workflowHint); err != nil {
		t.Fatal(err)
	}
	if workflowHint != hint {
		t.Fatal("OIDC state did not durably preserve the display hint")
	}
	initial, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	var publicID, hash, kind, storedHint, version string
	var issued, lastActive, idle, absolute time.Time
	if err := f.pool.QueryRow(t.Context(), `
		SELECT public_session_id, token_hash, kind, user_agent_hint, issued_at, last_used_at, idle_expires_at, expires_at, xmin::text
		FROM api_tokens WHERE id = $1`, initial.TokenID).Scan(&publicID, &hash, &kind, &storedHint, &issued, &lastActive, &idle, &absolute, &version); err != nil {
		t.Fatal(err)
	}
	if publicID == "" || publicID == initial.TokenID || publicID == hash || publicID == initial.AccessToken || hash != credentials.HashToken(initial.AccessToken) || kind != "browser" || storedHint != hint || !lastActive.Equal(issued) || idle.Sub(issued) != 5*time.Second || absolute.Sub(issued) != time.Hour {
		t.Fatal("OIDC issuance did not preserve independent references, hash-only credentials or browser policy")
	}
	if initial.ActivityIntervalMS != 1666 || !initial.IdleExpiresAt.Equal(idle) || !initial.ExpiresAt.Equal(absolute) {
		t.Fatal("OIDC issuance did not return its stored policy")
	}
	f.advance(2 * time.Second)
	replay, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if replay.AccessToken != "" || !replay.AlreadyCompleted || replay.TokenID != initial.TokenID || replay.Principal != initial.Principal || !replay.ExpiresAt.Equal(absolute) || !replay.IdleExpiresAt.Equal(idle) || replay.ActivityIntervalMS != 1666 || f.idp.ExchangeCount() != 1 {
		t.Fatal("OIDC completed replay changed the original credential or policy")
	}
	var afterVersion string
	var afterActivity, afterIdle time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT xmin::text, last_used_at, idle_expires_at FROM api_tokens WHERE id = $1`, initial.TokenID).Scan(&afterVersion, &afterActivity, &afterIdle); err != nil {
		t.Fatal(err)
	}
	if afterVersion != version || !afterActivity.Equal(lastActive) || !afterIdle.Equal(idle) {
		t.Fatal("OIDC replay modified browser activity")
	}
}

func TestOIDCBrowserCompletedReplayOutlivesOnlyTheLoginWorkflowDeadline(t *testing.T) {
	f := browserOIDCFixture(t)
	input := f.start(t)
	initial, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	f.advance(2 * time.Minute) // OIDC workflow TTL is 1m; browser idle is 30m.
	replay, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil || !replay.AlreadyCompleted || replay.TokenID != initial.TokenID || replay.AccessToken != "" || f.idp.ExchangeCount() != 1 {
		t.Fatalf("a live completed browser session was treated as an expired login workflow: %v", err)
	}
}

func TestOIDCBrowserCompletedReplayRechecksFactsAfterStateLockWait(t *testing.T) {
	for _, invalid := range []string{"revoked", "user-disabled", "membership-disabled", "membership-deleted", "organization-disabled", "idle-expired", "absolute-expired"} {
		t.Run(invalid, func(t *testing.T) {
			f := browserOIDCFixture(t)
			if invalid == "membership-deleted" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET source = 'scim', scim_user_name = email WHERE id = $1`, f.user.Membership.ID); err != nil {
					t.Fatal(err)
				}
			}
			input := f.start(t)
			initial, err := f.flow.CompleteLogin(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			var stateID string
			var blockerPID uint32
			if err := blocker.QueryRow(ctx, `SELECT id, pg_backend_pid() FROM oidc_auth_sessions WHERE state_hash = $1 FOR UPDATE`, credentials.HashToken(input.State)).Scan(&stateID, &blockerPID); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			f.repository.Repository = f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM oidc_auth_sessions") && strings.Contains(sql, "FOR UPDATE") {
					captured.Do(func() { pid <- conn.PgConn().PID() })
				}
			}).OIDC()
			type outcome struct {
				result oidcflow.CompleteLoginResult
				err    error
			}
			finished := make(chan outcome, 1)
			workers.Go(func() { result, err := f.flow.CompleteLogin(ctx, input); finished <- outcome{result, err} })
			select {
			case id := <-pid:
				waitForDatabaseLock(t, ctx, f.pool, id)
				var blockedByState bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blockerPID, id).Scan(&blockedByState); err != nil || !blockedByState {
					t.Fatalf("replay did not block on the original state transaction: %v", err)
				}
			case result := <-finished:
				t.Fatalf("completed replay bypassed the state lock: %v", result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var mutation string
			var target string
			switch invalid {
			case "revoked":
				mutation, target = `UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, initial.TokenID
			case "user-disabled":
				mutation, target = `UPDATE users SET active = FALSE WHERE id = $1`, initial.Principal.UserID
			case "membership-disabled":
				mutation, target = `UPDATE organization_memberships SET active = FALSE WHERE id = $1`, initial.Principal.MembershipID
			case "membership-deleted":
				mutation, target = `UPDATE organization_memberships SET scim_deleted_at = now(), active = FALSE WHERE id = $1`, initial.Principal.MembershipID
			case "organization-disabled":
				mutation, target = `UPDATE organizations SET active = FALSE WHERE id = $1`, initial.Principal.OrganizationID
			case "idle-expired":
				f.now.Store(initial.IdleExpiresAt.UnixNano())
			case "absolute-expired":
				mutation, target = `UPDATE api_tokens SET idle_expires_at = expires_at + interval '1 hour' WHERE id = $1`, initial.TokenID
				f.now.Store(initial.ExpiresAt.UnixNano())
			}
			if mutation != "" {
				if _, err := blocker.Exec(ctx, mutation, target); err != nil {
					t.Fatal(err)
				}
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-finished:
				if code, _, _ := domain.ErrorDetails(result.err); code != "oidc_completed_token_unavailable" || result.result.AccessToken != "" || result.result.TokenID != "" {
					t.Fatalf("stale completed authority returned a session: %v", result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var status string
			var tokens, links, completedEvents int
			var issued, activity time.Time
			if err := f.pool.QueryRow(ctx, `
				SELECT status, (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities),
				       (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed'),
				       (SELECT issued_at FROM api_tokens WHERE id = $2), (SELECT last_used_at FROM api_tokens WHERE id = $2)
				FROM oidc_auth_sessions WHERE id = $1`, stateID, initial.TokenID).Scan(&status, &tokens, &links, &completedEvents, &issued, &activity); err != nil {
				t.Fatal(err)
			}
			if status != "completed" || tokens != 1 || links != 1 || completedEvents != 1 || f.idp.ExchangeCount() != 1 || !activity.Equal(issued) {
				t.Fatal("denied replay changed workflow, repeated exchange, issued another credential or recorded activity")
			}
		})
	}
}

func TestOIDCBrowserIssuanceAdmitsOnlyLivePersistedPrecision(t *testing.T) {
	for _, boundary := range []string{"idle", "absolute"} {
		for _, precision := range []time.Duration{time.Nanosecond, time.Microsecond} {
			t.Run(boundary+"/"+precision.String(), func(t *testing.T) {
				idleTTL, absoluteTTL := precision, time.Hour
				if boundary == "absolute" {
					idleTTL, absoluteTTL = time.Hour, precision
				}
				f := browserOIDCFixtureWithTokenTTL(t, absoluteTTL)
				f.now.Store(f.time().Truncate(time.Microsecond).UnixNano())
				if err := f.store.InitializeBrowserSessions(t.Context(), idleTTL); err != nil {
					t.Fatal(err)
				}
				result, err := f.flow.CompleteLogin(t.Context(), f.start(t))
				if precision == time.Nanosecond && (!errors.Is(err, domain.ErrUnauthenticated) || result.AccessToken != "" || result.TokenID != "") {
					t.Fatalf("expired stored OIDC deadline did not fail admission: %v", err)
				}
				if precision == time.Microsecond && (err != nil || result.AccessToken == "" || !result.IdleExpiresAt.After(f.time())) {
					t.Fatalf("representable live OIDC deadline was not admitted: %v", err)
				}
				var tokens, links, completedEvents int
				if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities), (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')`).Scan(&tokens, &links, &completedEvents); err != nil {
					t.Fatal(err)
				}
				want := 0
				if precision == time.Microsecond {
					want = 1
				}
				if tokens != want || links != want || completedEvents != want {
					t.Fatal("OIDC issuance did not atomically admit or roll back its credential, link and event")
				}
			})
		}
	}
}
