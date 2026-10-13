package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func directoryLifecycleChange(ctx context.Context, service *directory.Service, f scimIssuerFixture, operation, actorID string) error {
	if operation == "user-inactive" || operation == "user-active" || operation == "unchanged" {
		return service.SetUserActive(ctx, directory.SetUserActiveInput{RequestID: "directory-final-authority", ActorPrincipalID: actorID,
			UserID: f.user.User.ID, Active: operation != "user-inactive"})
	}
	member := f.members[0]
	role, active := domain.OrganizationRoleAdmin, true
	if operation == "demote" {
		role = domain.OrganizationRoleMember
	} else if operation == "membership-inactive" {
		active = false
	}
	_, err := service.UpdateMembership(ctx, directory.UpdateMembershipInput{RequestID: "directory-final-authority", ActorPrincipalID: actorID,
		OrganizationID: member.OrganizationID, MembershipID: member.ID, Email: member.Email, DisplayName: "Updated directory issuer", Role: role, Active: active})
	return err
}

func directoryDeadline(t *testing.T, f scimIssuerFixture, ctx context.Context, deadline string) time.Duration {
	t.Helper()
	if deadline == "valid" {
		return time.Second
	}
	if deadline == "cct" {
		// CCT has a 60-second lifetime and permits 30 seconds of clock skew.
		return 91 * time.Second
	}
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	query := `UPDATE api_tokens SET idle_expires_at=$2 WHERE id=$1`
	if deadline == "absolute" {
		query = `UPDATE api_tokens SET expires_at=$2 WHERE id=$1`
	}
	if _, err := f.pool.Exec(t.Context(), query, caller.Claims().Session, f.clock().Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	return 5 * time.Second
}

func waitDirectoryMutation(t *testing.T, ctx context.Context, f scimIssuerFixture, waiting <-chan uint32, blocker pgx.Tx, done <-chan error) {
	t.Helper()
	select {
	case pid := <-waiting:
		if finished, err := waitSCIMLineageRival(t, ctx, f.pool, pid, blocker.Conn().PgConn().PID(), done); finished {
			t.Fatalf("directory mutation bypassed owned blocker: %v", err)
		}
	case err := <-done:
		t.Fatalf("directory mutation never reached required lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDirectoryLifecycleRechecksAuthorityAfterFinalWait(t *testing.T) {
	for _, operation := range []string{"demote", "membership-inactive", "user-inactive", "user-active", "edit"} {
		waits := []string{"audit", "feed"}
		if operation == "user-active" || operation == "edit" {
			waits = []string{"audit"}
		}
		for _, wait := range waits {
			for _, deadline := range []string{"idle", "absolute", "cct"} {
				t.Run(operation+"/"+wait+"/"+deadline, func(t *testing.T) {
					f := newSCIMIssuerFixture(t)
					if operation == "user-active" {
						if _, err := f.pool.Exec(t.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, f.user.User.ID); err != nil {
							t.Fatal(err)
						}
					}
					advance := directoryDeadline(t, f, f.adminCtx, deadline)
					ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
					var workers sync.WaitGroup
					defer func() { cancel(); workers.Wait() }()
					blocker, err := f.pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
					lock, match := `SELECT pg_advisory_xact_lock(660018::bigint)`, "INSERT INTO identity_events"
					if wait == "feed" {
						lock, match = `LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE`, "LOCK TABLE session_revocations"
					} else {
						// Issuer-loss audit inserts happen earlier. Block only the
						// final Directory audit, after the lifecycle writes.
						if _, err := f.pool.Exec(ctx, `CREATE FUNCTION pause_directory_final_audit() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN IF NEW.event_type IN ('organization_membership.updated','user.deactivated','user.activated')
						THEN PERFORM pg_advisory_xact_lock(660018::bigint); END IF; RETURN NEW; END $$;
						CREATE TRIGGER pause_directory_final_audit BEFORE INSERT ON identity_events
						FOR EACH ROW EXECUTE FUNCTION pause_directory_final_audit()`); err != nil {
							t.Fatal(err)
						}
					}
					if _, err := blocker.Exec(ctx, lock); err != nil {
						t.Fatal(err)
					}
					state := scimVersionFixture{bindingFixture: f.bindingFixture}
					before := state.versionSnapshot(t)
					waiting := make(chan uint32, 1)
					var once sync.Once
					store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
						if strings.Contains(sql, match) {
							once.Do(func() { waiting <- conn.PgConn().PID() })
						}
					})
					service := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t))
					done := make(chan error, 1)
					workers.Go(func() { done <- directoryLifecycleChange(ctx, service, f, operation, f.admin.User.ID) })
					waitDirectoryMutation(t, ctx, f, waiting, blocker, done)
					f.advance(advance)
					if err := blocker.Rollback(ctx); err != nil {
						t.Fatal(err)
					}
					if err := <-done; !errors.Is(err, callercontext.ErrInvalid) {
						t.Fatalf("expired administrator committed after final wait: %v", err)
					}
					if state.versionSnapshot(t) != before {
						t.Fatal("late authority failure left resources, SCIM Token/xmin, browser sessions or audit/feed effects")
					}
				})
			}
		}
	}
}

func TestDirectoryLifecycleSelfChangesUseOriginalAuthority(t *testing.T) {
	for _, operation := range []string{"demote", "membership-inactive"} {
		for _, deadline := range []string{"valid", "idle", "absolute", "cct"} {
			t.Run(operation+"/"+deadline, func(t *testing.T) {
				f := newSCIMIssuerFixture(t)
				advance := directoryDeadline(t, f, f.issuerCtx, deadline)
				ctx, cancel := context.WithTimeout(f.issuerCtx, 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `LOCK TABLE session_revocations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
					t.Fatal(err)
				}
				state := scimVersionFixture{bindingFixture: f.bindingFixture}
				before, otherOrg := state.versionSnapshot(t), f.tokenRow(t, f.tokens[1].Token.ID, false)
				waiting := make(chan uint32, 1)
				var once sync.Once
				store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "LOCK TABLE session_revocations") {
						once.Do(func() { waiting <- conn.PgConn().PID() })
					}
				})
				service := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t))
				done := make(chan error, 1)
				workers.Go(func() { done <- directoryLifecycleChange(ctx, service, f, operation, f.user.User.ID) })
				waitDirectoryMutation(t, ctx, f, waiting, blocker, done)
				f.advance(advance)
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				err = <-done
				if deadline != "valid" {
					if !errors.Is(err, callercontext.ErrInvalid) || state.versionSnapshot(t) != before {
						t.Fatalf("expired self change committed after feed wait: %v", err)
					}
					return
				}
				if err != nil {
					t.Fatalf("valid self change was denied by its own revocation: %v", err)
				}
				caller, err := callercontext.CallerFromContext(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := caller.Revalidate(ctx, f.store.LocalAuth().ResolveSession); !errors.Is(err, callercontext.ErrInvalid) {
					t.Fatal("self change retained its previous administrator session")
				}
				reason := "role_changed"
				if operation == "membership-inactive" {
					reason = "membership_deactivated"
				}
				var sessionRevoked bool
				var matchingFeed, allFeed int
				if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,
					(SELECT count(*) FROM session_revocations WHERE token_id=$1 AND reason=$2 AND user_id=$3 AND organization_id=$4),
					(SELECT count(*) FROM session_revocations WHERE token_id=$1) FROM api_tokens WHERE id=$1`,
					caller.Claims().Session, reason, f.user.User.ID, f.members[0].OrganizationID).Scan(&sessionRevoked, &matchingFeed, &allFeed); err != nil || !sessionRevoked || matchingFeed != 1 || allFeed != 1 {
					t.Fatalf("self change did not persist exact session revocation: revoked=%v matching=%d all=%d error=%v", sessionRevoked, matchingFeed, allFeed, err)
				}
				var revoked bool
				if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM scim_tokens WHERE id=$1`, f.tokens[0].Token.ID).Scan(&revoked); err != nil || !revoked {
					t.Fatalf("self change retained issuer Token: %v", err)
				}
				var active bool
				var role domain.OrganizationRole
				if err := f.pool.QueryRow(ctx, `SELECT active,role FROM organization_memberships WHERE id=$1`, f.members[0].ID).Scan(&active, &role); err != nil {
					t.Fatal(err)
				}
				if active != (operation == "demote") || (role == domain.OrganizationRoleMember) != (operation == "demote") || f.tokenRow(t, f.tokens[1].Token.ID, false) != otherOrg {
					t.Fatal("self change did not preserve its intended scope")
				}
			})
		}
	}
}

func TestDirectoryLifecycleLocksCallerAndTargetSessionsInOrder(t *testing.T) {
	for _, operation := range []string{"demote", "user-inactive"} {
		for _, actorOrder := range []string{"first", "last"} {
			t.Run(operation+"/actor-"+actorOrder, func(t *testing.T) {
				f := newSCIMIssuerFixture(t)
				actor := f.browser.login(t, "admission", "admin@example.com")
				target := f.browser.login(t, "admission", "member@example.com")
				actorID, targetID := "token-a-actor", "token-z-target"
				if actorOrder == "last" {
					actorID, targetID = "token-z-actor", "token-a-target"
				}
				if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET revoked_at=$2 WHERE user_id=$1 AND id<>$3 AND revoked_at IS NULL`, f.user.User.ID, f.clock(), target.TokenID); err != nil {
					t.Fatal(err)
				}
				for _, rename := range []struct{ old, next string }{{actor.TokenID, actorID}, {target.TokenID, targetID}} {
					if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET id=$2 WHERE id=$1`, rename.old, rename.next); err != nil {
						t.Fatal(err)
					}
				}
				ctx, cancel := context.WithTimeout(f.browser.caller(t, actor), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				small, large := actorID, targetID
				if small > large {
					small, large = large, small
				}
				if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, large); err != nil {
					t.Fatal(err)
				}
				waiting := make(chan uint32, 1)
				var once sync.Once
				store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM api_tokens") && strings.Contains(sql, "FOR UPDATE") {
						once.Do(func() { waiting <- conn.PgConn().PID() })
					}
				})
				service := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t))
				done := make(chan error, 1)
				workers.Go(func() { done <- directoryLifecycleChange(ctx, service, f, operation, f.admin.User.ID) })
				waitDirectoryMutation(t, ctx, f, waiting, blocker, done)
				probe, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				_, lockErr := probe.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE NOWAIT`, small)
				_ = probe.Rollback(context.WithoutCancel(ctx))
				var pgErr *pgconn.PgError
				if !errors.As(lockErr, &pgErr) || pgErr.Code != "55P03" {
					t.Fatalf("smaller session was not held before larger-session wait: %v", lockErr)
				}
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				var targetRevoked, actorRevoked bool
				if err := f.pool.QueryRow(ctx, `SELECT (SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=$1),(SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=$2)`, targetID, actorID).Scan(&targetRevoked, &actorRevoked); err != nil || !targetRevoked || actorRevoked {
					t.Fatalf("caller/target session scope changed: target=%v actor=%v error=%v", targetRevoked, actorRevoked, err)
				}
				if _, err := f.browser.auth.Resolve(ctx, actor.AccessToken); err != nil {
					t.Fatalf("directory operation revoked administrator's own credential: %v", err)
				}
			})
		}
	}
}

func TestDirectoryLifecycleLocksCallerWithoutTargetRevocation(t *testing.T) {
	for _, operation := range []string{"edit", "user-active", "unchanged"} {
		t.Run(operation, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			if operation == "user-active" {
				if _, err := f.pool.Exec(t.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, f.user.User.ID); err != nil {
					t.Fatal(err)
				}
			}
			caller, err := callercontext.CallerFromContext(f.adminCtx)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, caller.Claims().Session); err != nil {
				t.Fatal(err)
			}
			state := scimVersionFixture{bindingFixture: f.bindingFixture}
			before := state.versionSnapshot(t)
			waiting := make(chan uint32, 1)
			var once sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM api_tokens") && strings.Contains(sql, "FOR UPDATE") {
					once.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			service := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t))
			done := make(chan error, 1)
			workers.Go(func() { done <- directoryLifecycleChange(ctx, service, f, operation, f.admin.User.ID) })
			waitDirectoryMutation(t, ctx, f, waiting, blocker, done)
			f.advance(91 * time.Second)
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, callercontext.ErrInvalid) || state.versionSnapshot(t) != before {
				t.Fatalf("caller-only admission committed after signed authority expired: %v", err)
			}
		})
	}
}
