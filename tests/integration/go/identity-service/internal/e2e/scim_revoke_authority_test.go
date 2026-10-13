package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestSCIMManualRevokeRevalidatesAfterTokenWait(t *testing.T) {
	for _, change := range []string{"clock", "cct-expired", "session-revoked"} {
		t.Run(change, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE`, f.auth.TokenID); err != nil {
				t.Fatal(err)
			}
			waiting := make(chan uint32, 1)
			var once sync.Once
			service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM scim_tokens") && strings.Contains(sql, "FOR UPDATE") {
					once.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			done := make(chan error, 1)
			workers.Go(func() { done <- service.RevokeToken(ctx, f.admin.User.ID, f.auth.TokenID) })
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
				var actualOwner bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&actualOwner); err != nil || !actualOwner {
					t.Fatalf("manual revoke did not wait for the owned Token lock: %v", err)
				}
			case err := <-done:
				t.Fatalf("manual revoke bypassed Token wait: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			switch change {
			case "clock":
				f.advance(time.Second + 123*time.Nanosecond)
			case "cct-expired":
				// The shared verifier permits 30 seconds of clock tolerance.
				f.advance(91 * time.Second)
			case "session-revoked":
				caller, err := callercontext.CallerFromContext(f.adminCtx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(ctx, `UPDATE api_tokens SET revoked_at=$2 WHERE id=$1`, caller.Claims().Session, f.clock()); err != nil {
					t.Fatal(err)
				}
			}
			before := f.versionSnapshot(t)
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if change == "clock" {
					if err != nil {
						t.Fatal(err)
					}
					var revoked, audited time.Time
					if err := f.pool.QueryRow(ctx, `SELECT t.revoked_at,e.created_at FROM scim_tokens t JOIN identity_events e
						ON e.subject_id=t.id AND e.event_type='scim_token.revoked' WHERE t.id=$1`, f.auth.TokenID).Scan(&revoked, &audited); err != nil {
						t.Fatal(err)
					}
					want := f.clock().UTC().Truncate(time.Microsecond)
					if !revoked.Equal(want) || !audited.Equal(want) {
						t.Fatalf("manual revoke reused pre-wait time: revoked=%v audit=%v want=%v", revoked, audited, want)
					}
				} else if !errors.Is(err, callercontext.ErrInvalid) || f.versionSnapshot(t) != before {
					t.Fatalf("stale caller revoked a SCIM Token or changed durable state: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestSCIMManualRevokeRevalidatesAfterAuditWait(t *testing.T) {
	f := newSCIMVersionFixture(t)
	before := f.versionSnapshot(t)
	ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(660019)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION wait_manual_scim_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.event_type='scim_token.revoked' THEN PERFORM pg_advisory_xact_lock(660019); END IF; RETURN NEW; END $$;
		CREATE TRIGGER wait_manual_scim_audit BEFORE INSERT ON identity_events FOR EACH ROW EXECUTE FUNCTION wait_manual_scim_audit()`); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan uint32, 1)
	var once sync.Once
	service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO identity_events") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	done := make(chan error, 1)
	workers.Go(func() { done <- service.RevokeToken(ctx, f.admin.User.ID, f.auth.TokenID) })
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
		var actualOwner bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&actualOwner); err != nil || !actualOwner {
			t.Fatalf("audit did not wait for the owned barrier: %v", err)
		}
	case err := <-done:
		t.Fatalf("manual revoke bypassed audit barrier: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	f.advance(91 * time.Second)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, callercontext.ErrInvalid) || f.versionSnapshot(t) != before {
			t.Fatalf("expired CCT committed after audit wait: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestSCIMManualRevokeRejectsExpiredCallerOnIdempotentPath(t *testing.T) {
	f := newSCIMVersionFixture(t)
	if err := f.service.RevokeToken(f.adminCtx, f.admin.User.ID, f.auth.TokenID); err != nil {
		t.Fatal(err)
	}
	f.advance(91 * time.Second)
	before := f.versionSnapshot(t)
	if err := f.service.RevokeToken(f.adminCtx, f.admin.User.ID, f.auth.TokenID); !errors.Is(err, callercontext.ErrInvalid) || f.versionSnapshot(t) != before {
		t.Fatalf("idempotent revocation bypassed current caller authority: %v", err)
	}
}

func TestSCIMManualRevokeLocksAuthorityBeforeToken(t *testing.T) {
	f := newSCIMIssuerFixture(t)
	ctx, cancel := context.WithTimeout(f.issuerCtx, 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan uint32, 1)
	var once sync.Once
	service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR SHARE") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	done := make(chan error, 1)
	workers.Go(func() { done <- service.RevokeToken(ctx, f.user.User.ID, f.tokens[0].Token.ID) })
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-done:
		t.Fatalf("manual revoke bypassed User authority lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, lockErr := probe.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE NOWAIT`, f.tokens[0].Token.ID)
	_ = probe.Rollback(context.WithoutCancel(ctx))
	if lockErr != nil {
		t.Fatalf("manual revoke holds Token before User and can deadlock with issuer loss: %v", lockErr)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestSCIMManualRevokeAndIssuerOffboardingSerialize(t *testing.T) {
	for _, mode := range []string{"demote", "global"} {
		for _, first := range []string{"revoke", "offboard"} {
			t.Run(mode+"/"+first+"-first", func(t *testing.T) {
				f := newSCIMIssuerFixture(t)
				unrelatedBefore := f.tokenRow(t, f.unrelated.Token.ID, false)
				otherBefore := f.tokenRow(t, f.tokens[1].Token.ID, true)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				release := make(chan struct{})
				ownerPID, rivalPID := make(chan uint32, 1), make(chan uint32, 1)
				var ownerOnce, rivalOnce sync.Once
				owner := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
					// Offboarding owns its authority parents but has not yet
					// locked Tokens. A Token-first rival creates a real cycle.
					atRevoke := first == "revoke" && strings.Contains(sql, "UPDATE scim_tokens") && strings.Contains(sql, "revoked_at")
					atOffboard := first == "offboard" && strings.Contains(sql, "FROM scim_tokens") && strings.Contains(sql, "FOR UPDATE")
					if atRevoke || atOffboard {
						ownerOnce.Do(func() {
							ownerPID <- conn.PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
							}
						})
					}
				})
				rival := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM users") && (strings.Contains(sql, "FOR SHARE") || strings.Contains(sql, "FOR UPDATE")) || strings.Contains(sql, "FROM scim_tokens") && strings.Contains(sql, "FOR UPDATE") {
						rivalOnce.Do(func() { rivalPID <- conn.PgConn().PID() })
					}
				})
				ownerDone, rivalDone := make(chan error, 1), make(chan error, 1)
				revoke := func(store scimRevoker) error {
					caller, err := callercontext.CallerFromContext(f.issuerCtx)
					if err != nil {
						return err
					}
					return store.RevokeToken(callercontext.WithCaller(ctx, caller), f.user.User.ID, f.tokens[0].Token.ID, f.clock())
				}
				offboard := func(adapter directory.Repository) error {
					caller, err := callercontext.CallerFromContext(f.adminCtx)
					if err != nil {
						return err
					}
					service := directory.NewService(adapter, f.newID, f.clock, testPasswordEngine(t))
					callCtx := callercontext.WithCaller(ctx, caller)
					if mode == "global" {
						return service.SetUserActive(callCtx, directory.SetUserActiveInput{ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: false})
					}
					member := f.members[0]
					_, err = service.UpdateMembership(callCtx, directory.UpdateMembershipInput{ActorPrincipalID: f.admin.User.ID, OrganizationID: member.OrganizationID,
						MembershipID: member.ID, Email: member.Email, DisplayName: member.DisplayName, Role: domain.OrganizationRoleMember, Active: true})
					return err
				}
				workers.Go(func() {
					if first == "revoke" {
						ownerDone <- revoke(owner.SCIM())
					} else {
						ownerDone <- offboard(owner.Directory())
					}
				})
				var ownerID uint32
				select {
				case ownerID = <-ownerPID:
				case err := <-ownerDone:
					t.Fatalf("first operation did not reach locked Token mutation: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Go(func() {
					if first == "revoke" {
						rivalDone <- offboard(rival.Directory())
					} else {
						rivalDone <- revoke(rival.SCIM())
					}
				})
				var rivalID uint32
				select {
				case rivalID = <-rivalPID:
				case err := <-rivalDone:
					t.Fatalf("rival did not attempt an authority or Token lock: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				finished, rivalErr := waitSCIMLineageRival(t, ctx, f.pool, rivalID, ownerID, rivalDone)
				if finished {
					t.Fatalf("rival bypassed the uncommitted owner: %v", rivalErr)
				}
				close(release)
				select {
				case err := <-ownerDone:
					if err != nil {
						t.Fatal(err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				select {
				case err := <-rivalDone:
					if first == "revoke" && err != nil || first == "offboard" && !errors.Is(err, callercontext.ErrInvalid) && !errors.Is(err, domain.ErrForbidden) {
						t.Fatalf("incorrect serialized outcome: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				var revoked bool
				var audits int
				if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,
					(SELECT count(*) FROM identity_events e WHERE e.subject_id=t.id AND e.event_type='scim_token.revoked')
					FROM scim_tokens t WHERE id=$1`, f.tokens[0].Token.ID).Scan(&revoked, &audits); err != nil || !revoked || audits != 1 {
					t.Fatalf("serialized revocation must persist exactly once: revoked=%v audits=%d err=%v", revoked, audits, err)
				}
				principal, err := f.store.Directory().GetPrincipal(ctx, f.user.User.ID, "")
				if err != nil || principal.Active != (mode != "global") {
					t.Fatalf("offboarding did not persist global activity: %+v %v", principal, err)
				}
				member, err := f.store.Directory().GetMembership(ctx, f.members[0].OrganizationID, f.members[0].ID)
				wantRole := domain.OrganizationRoleAdmin
				if mode == "demote" {
					wantRole = domain.OrganizationRoleMember
				}
				if err != nil || !member.Active || member.Role != wantRole {
					t.Fatalf("offboarding did not persist Membership authority: %+v %v", member, err)
				}
				if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,
					(SELECT count(*) FROM identity_events e WHERE e.subject_id=t.id AND e.event_type='scim_token.revoked')
					FROM scim_tokens t WHERE id=$1`, f.tokens[1].Token.ID).Scan(&revoked, &audits); err != nil {
					t.Fatal(err)
				}
				wantAudits := 0
				if mode == "global" {
					wantAudits = 1
				}
				if revoked != (mode == "global") || audits != wantAudits || f.tokenRow(t, f.tokens[1].Token.ID, true) != otherBefore || f.tokenRow(t, f.unrelated.Token.ID, false) != unrelatedBefore {
					t.Fatalf("serialized offboarding violated issuer/organization scope: revoked=%v audits=%d", revoked, audits)
				}
			})
		}
	}
}

type scimRevoker interface {
	RevokeToken(context.Context, string, string, time.Time) error
}
