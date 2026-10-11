package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

// A terminal page proves only the committed snapshot of that read. An already
// allocated but uncommitted sequence must never become the returned cursor.
func TestBrowserSessionFeedTerminalPageFromNonzeroCursor(t *testing.T) {
	for _, commit := range []bool{true, false} {
		name := "commit"
		if !commit {
			name = "rollback"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			seedA := f.login(t, "admission", "member@example.com")
			seedB := f.login(t, "admission", "member@example.com")
			login := f.login(t, "admission", "member@example.com")
			ctx, cancel := context.WithTimeout(f.caller(t, login), 12*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			for _, seed := range []localauth.LoginResult{seedA, seedB} {
				if status, err := f.auth.RevokeByAccessToken(ctx, seed.AccessToken); err != nil || status != localauth.RevokeStatusRevoked {
					t.Fatalf("seed committed event: %v", err)
				}
			}
			read := func(after int64, limit int) domain.SessionRevocationPage {
				t.Helper()
				page, err := f.service.ListRevocations(ctx, browsersessions.RevocationQuery{AfterSequence: after, Limit: limit})
				if err != nil || page.Events == nil {
					t.Fatalf("read session page: %v", err)
				}
				return page
			}
			firstPage := read(0, 1)
			assertSingleSessionFeedEvent(t, firstPage, 0, seedA.TokenID, f.user.User.ID, f.user.Membership.OrganizationID)
			afterA := firstPage.NextSequence

			predecessor, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			// Release the table lock before cancelling and joining the real writer,
			// including when any assertion below interrupts this subtest.
			defer func() { _ = predecessor.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := predecessor.Exec(ctx, `LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			var allocatedSequence int64
			if err := predecessor.QueryRow(ctx, `INSERT INTO session_revocations (token_id, user_id, organization_id, reason, occurred_at) VALUES ('terminal-predecessor', $1, $2, 'session_revoked', $3) RETURNING sequence`, f.admin.User.ID, f.admin.Organization.ID, f.clock()).Scan(&allocatedSequence); err != nil {
				t.Fatal(err)
			}
			pid := make(chan uint32, 1)
			var captured sync.Once
			store := f.tracedStore(t, func(_ context.Context, connection *pgx.Conn, sql string) {
				if strings.Contains(sql, "LOCK TABLE session_revocations") {
					captured.Do(func() { pid <- connection.PgConn().PID() })
				}
			})
			type outcome struct {
				result browsersessions.RevokeResult
				err    error
			}
			finished := make(chan outcome, 1)
			workers.Go(func() {
				result, err := browsersessions.NewService(store.BrowserSessions()).Revoke(ctx, browsersessions.RevokeInput{RequestID: "nonzero-terminal", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Mode: "all"})
				finished <- outcome{result, err}
			})
			var writerPID uint32
			select {
			case writerPID = <-pid:
				assertBrowserBlocker(t, ctx, f, writerPID, predecessor.Conn().PgConn().PID())
			case result := <-finished:
				t.Fatalf("writer bypassed predecessor: %v", result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}

			// Both calls must complete while the predecessor remains uncommitted.
			// The short page advances to B, and the empty page preserves B, even
			// though the sequence allocator has already advanced beyond it.
			terminal := read(afterA, 500)
			assertSingleSessionFeedEvent(t, terminal, afterA, seedB.TokenID, f.user.User.ID, f.user.Membership.OrganizationID)
			afterB := terminal.NextSequence
			if afterB >= allocatedSequence {
				t.Fatal("terminal cursor reached an uncommitted sequence")
			}
			empty := read(afterB, 500)
			if len(empty.Events) != 0 || empty.NextSequence != afterB {
				t.Fatal("empty terminal page advanced past committed history")
			}
			assertBrowserBlocker(t, ctx, f, writerPID, predecessor.Conn().PgConn().PID())
			var allocator int64
			if err := f.pool.QueryRow(ctx, `SELECT last_value FROM session_revocations_sequence_seq`).Scan(&allocator); err != nil || allocator != allocatedSequence {
				t.Fatalf("blocked writer allocated a sequence before the predecessor finished: %v", err)
			}
			if err := finishRevocationPredecessor(ctx, predecessor, commit); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-finished:
				if result.err != nil || result.result.RevokedCount != 1 || !result.result.CurrentRevoked {
					t.Fatalf("real writer did not revoke exactly its current session: %v", result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}

			cursor := empty.NextSequence
			if commit {
				page := read(cursor, 1)
				assertSingleSessionFeedEvent(t, page, cursor, "terminal-predecessor", f.admin.User.ID, f.admin.Organization.ID)
				if page.NextSequence != allocatedSequence {
					t.Fatal("committed predecessor was skipped after terminal proof")
				}
				cursor = page.NextSequence
			}
			page := read(cursor, 1)
			assertSingleSessionFeedEvent(t, page, cursor, login.TokenID, f.user.User.ID, f.user.Membership.OrganizationID)
			if page.NextSequence <= allocatedSequence {
				t.Fatal("writer sequence did not follow the committed event or rollback gap")
			}
			last := page.NextSequence
			page = read(last, 500)
			if len(page.Events) != 0 || page.NextSequence != last {
				t.Fatal("continuation duplicated events or moved its final empty cursor")
			}
		})
	}
}

func assertSingleSessionFeedEvent(t *testing.T, page domain.SessionRevocationPage, after int64, tokenID, userID, organizationID string) {
	t.Helper()
	if len(page.Events) != 1 {
		t.Fatalf("session page contains %d events, want one", len(page.Events))
	}
	event := page.Events[0]
	if event.Sequence <= after || page.NextSequence != event.Sequence || event.TokenID != tokenID || event.UserID != userID || event.OrganizationID != organizationID || event.Reason != "session_revoked" || event.OccurredAt.IsZero() {
		t.Fatal("session page lost exact event identity or committed cursor order")
	}
}
