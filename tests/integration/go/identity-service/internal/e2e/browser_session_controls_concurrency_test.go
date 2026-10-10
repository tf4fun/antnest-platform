package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func assertBrowserBlocker(t *testing.T, ctx context.Context, f browserControlsFixture, blocked, blocker uint32) {
	t.Helper()
	waitForDatabaseLock(t, ctx, f.pool, blocked)
	var exact bool
	if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker, blocked).Scan(&exact); err != nil || !exact {
		t.Fatalf("browser operation did not wait on the intended transaction: %v", err)
	}
}

func TestBrowserMutualAdministratorRevocationDoesNotLockActors(t *testing.T) {
	f := newBrowserControlsFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET role = 'admin' WHERE id = $1`, f.user.Membership.ID); err != nil {
		t.Fatal(err)
	}
	admin := f.login(t, "admission", "admin@example.com")
	member := f.login(t, "admission", "member@example.com")
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	ready, release := make(chan struct{}, 2), make(chan struct{})
	type outcome struct {
		result browsersessions.RevokeResult
		err    error
	}
	finished := make(chan outcome, 2)
	for _, pair := range []struct {
		actor  localauth.LoginResult
		target string
	}{{admin, f.user.User.ID}, {member, f.admin.User.ID}} {
		var captured sync.Once
		store := f.tracedStore(t, func(queryCtx context.Context, _ *pgx.Conn, sql string) {
			if strings.Contains(sql, "ORDER BY id FOR UPDATE") && strings.Contains(sql, "api_tokens") {
				captured.Do(func() {
					ready <- struct{}{}
					select {
					case <-release:
					case <-queryCtx.Done():
					}
				})
			}
		})
		actor, err := callercontext.CallerFromContext(f.caller(t, pair.actor))
		if err != nil {
			t.Fatal(err)
		}
		input := browsersessions.RevokeInput{RequestID: "mutual-revoke", ActorPrincipalID: pair.actor.Principal.UserID, UserID: pair.target, Scope: "organization", Mode: "all"}
		workers.Go(func() {
			result, err := browsersessions.NewService(store.BrowserSessions()).Revoke(callercontext.WithCaller(ctx, actor), input)
			finished <- outcome{result, err}
		})
	}
	// Both transactions own their target User before either can proceed. Any
	// later actor User lock would create the deterministic opposite-order cycle.
	for range 2 {
		select {
		case <-ready:
		case <-ctx.Done():
			t.Fatal("mutual revocations did not acquire disjoint target Users")
		}
	}
	close(release)
	succeeded := 0
	for range 2 {
		select {
		case result := <-finished:
			if result.err == nil {
				succeeded++
				if result.result.RevokedCount != 1 || result.result.CurrentRevoked {
					t.Fatal("mutual administrator revocation escaped target scope")
				}
			} else if !errors.Is(result.err, callercontext.ErrInvalid) || result.result != (browsersessions.RevokeResult{}) {
				t.Fatalf("mutual revocation deadlocked or failed unexpectedly: %v", result.err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	// Either both were admitted before the first commit, or the second live
	// read observed its revoked SID. Both serializations are valid.
	var revoked, events int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations)`).Scan(&revoked, &events); err != nil {
		t.Fatal(err)
	}
	if succeeded < 1 || revoked != succeeded || events != succeeded {
		t.Fatal("mutual revocation lost atomic effects or emitted duplicate events")
	}
}

func TestBrowserBulkRevalidatesActorAfterTargetLockWait(t *testing.T) {
	for _, waitOn := range []string{"user", "token"} {
		t.Run(waitOn, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			admin := f.login(t, "admission", "admin@example.com")
			member := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, admin), 12*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			sql, id, marker := `SELECT id FROM users WHERE id = $1 FOR UPDATE`, f.user.User.ID, "FROM users"
			if waitOn == "token" {
				sql, id, marker = `SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE`, member.TokenID, "FROM api_tokens"
			}
			if _, err := blocker.Exec(ctx, sql, id); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, c *pgx.Conn, sql string) {
				if strings.Contains(sql, marker) && strings.Contains(sql, "FOR UPDATE") {
					captured.Do(func() { pid <- c.PgConn().PID() })
				}
			})
			type outcome struct {
				result browsersessions.RevokeResult
				err    error
			}
			finished := make(chan outcome, 1)
			workers.Go(func() {
				result, err := browsersessions.NewService(store.BrowserSessions()).Revoke(ctx, browsersessions.RevokeInput{RequestID: "post-wait-revoke", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Scope: "organization", Mode: "all"})
				finished <- outcome{result, err}
			})
			select {
			case p := <-pid:
				assertBrowserBlocker(t, ctx, f, p, blocker.Conn().PgConn().PID())
			case r := <-finished:
				t.Fatalf("bulk revocation bypassed target lock: %v", r.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if status, err := f.auth.RevokeByAccessToken(ctx, admin.AccessToken); err != nil || status != localauth.RevokeStatusRevoked {
				t.Fatalf("revoke actor while operation is blocked: %v", err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			r := <-finished
			if !errors.Is(r.err, callercontext.ErrInvalid) || r.result != (browsersessions.RevokeResult{}) {
				t.Fatalf("revoked actor retained pre-wait authority: %v", r.err)
			}
			var targetRevoked bool
			var targetEvents int
			if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL, (SELECT count(*) FROM session_revocations WHERE token_id = $1) FROM api_tokens WHERE id = $1`, member.TokenID).Scan(&targetRevoked, &targetEvents); err != nil {
				t.Fatal(err)
			}
			if targetRevoked || targetEvents != 0 {
				t.Fatal("revoked actor committed target effects")
			}
		})
	}
}

func TestBrowserOrganizationRevocationKeepsOtherOrganizationsAndRequiresMembership(t *testing.T) {
	f := newBrowserControlsFixture(t)
	member := f.login(t, "admission", "member@example.com")
	second := f.otherOrganization(t)
	other := f.login(t, second.Slug, "member@example.com")
	admin := f.login(t, "admission", "admin@example.com")
	ctx := f.caller(t, admin)
	input := browsersessions.RevokeInput{RequestID: "organization-only", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Scope: "organization", Mode: "all"}
	result, err := f.service.Revoke(ctx, input)
	if err != nil || result.RevokedCount != 1 || result.CurrentRevoked {
		t.Fatalf("organization revoke: %v", err)
	}
	if _, err := f.auth.Resolve(ctx, member.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("organization target session survived revocation")
	}
	if _, err := f.auth.Resolve(ctx, other.AccessToken); err != nil {
		t.Fatal("system administrator revoked another organization's session")
	}
	if _, err := f.pool.Exec(ctx, `UPDATE organization_memberships SET scim_deleted_at = $2, source = 'scim', scim_user_name = 'removed', active = FALSE WHERE id = $1`, f.user.Membership.ID, f.clock()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Revoke(ctx, input); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("system admin bypassed target membership requirement: %v", err)
	}
	if _, err := f.service.List(ctx, browsersessions.ListInput{ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Scope: "organization", Limit: 10}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("system admin inventoried a nonmember: %v", err)
	}
}

func TestBrowserSessionFeedCommitOrderAndRollbackGaps(t *testing.T) {
	for _, commit := range []bool{true, false} {
		name := "commit"
		if !commit {
			name = "rollback"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, login), 12*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			first, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = first.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := first.Exec(ctx, `LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			var sequence int64
			if err := first.QueryRow(ctx, `INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at) VALUES ('predecessor', $1, $2, 'session_revoked', $3) RETURNING sequence`, f.admin.User.ID, f.admin.Organization.ID, f.clock()).Scan(&sequence); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, c *pgx.Conn, sql string) {
				if strings.Contains(sql, "LOCK TABLE session_revocations") {
					captured.Do(func() { pid <- c.PgConn().PID() })
				}
			})
			finished := make(chan error, 1)
			workers.Go(func() {
				_, err := browsersessions.NewService(store.BrowserSessions()).Revoke(ctx, browsersessions.RevokeInput{RequestID: "feed-order", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Mode: "all"})
				finished <- err
			})
			select {
			case p := <-pid:
				assertBrowserBlocker(t, ctx, f, p, first.Conn().PgConn().PID())
			case err := <-finished:
				t.Fatalf("session revocation bypassed feed writer lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var allocated int64
			if err := f.pool.QueryRow(ctx, `SELECT last_value FROM session_revocations_sequence_seq`).Scan(&allocated); err != nil || allocated != sequence {
				t.Fatalf("blocked writer allocated a sequence before admission: %v", err)
			}
			page, err := f.service.ListRevocations(ctx, browsersessions.RevocationQuery{Limit: 500})
			if err != nil || len(page.Events) != 0 || page.NextSequence != 0 {
				t.Fatalf("uncommitted session event escaped: %v", err)
			}
			if err := finishRevocationPredecessor(ctx, first, commit); err != nil {
				t.Fatal(err)
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			page, err = f.service.ListRevocations(ctx, browsersessions.RevocationQuery{Limit: 500})
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if commit {
				want = 2
			}
			if len(page.Events) != want || page.Events[len(page.Events)-1].Sequence <= sequence || page.Events[len(page.Events)-1].TokenID != login.TokenID {
				t.Fatal("committed sequence order or rollback gap was not preserved")
			}
			if commit && (page.Events[0].TokenID != "predecessor" || page.Events[0].Sequence != sequence) {
				t.Fatal("committed predecessor was skipped")
			}
		})
	}
}
