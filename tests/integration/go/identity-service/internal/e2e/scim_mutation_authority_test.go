package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

var scimMutationKinds = []string{"create-user", "replace-user", "delete-user", "create-group", "replace-group", "delete-group"}

func (f scimVersionFixture) mutate(ctx context.Context, service *scim.Service, kind string, condition *scim.IfMatchCondition) error {
	var err error
	switch kind {
	case "create-user":
		_, err = service.CreateUser(ctx, f.auth, scim.UserInput{ExternalID: "new-authority-subject", UserName: "authority-new@example.com", Email: "authority-new@example.com", DisplayName: "New authority member", Active: true})
	case "replace-user":
		member := f.user.Membership
		_, err = service.ReplaceUser(ctx, f.auth, member.ID, scim.ReplaceUserInput{UserInput: scim.UserInput{
			ExternalID: member.SCIMExternalID, UserName: member.SCIMUserName, Email: member.Email, DisplayName: "Changed authority member", Active: false,
		}, IfMatch: condition})
	case "delete-user":
		err = service.DeleteUser(ctx, f.auth, f.user.Membership.ID, condition)
	case "create-group":
		_, err = service.CreateGroup(ctx, f.auth, scim.GroupInput{DisplayName: "New authority group", MemberIDs: []string{f.user.Membership.ID}})
	case "replace-group":
		_, err = service.ReplaceGroup(ctx, f.auth, f.group.Group.ID, scim.ReplaceGroupInput{GroupInput: scim.GroupInput{DisplayName: "Changed authority group"}, IfMatch: condition})
	case "delete-group":
		err = service.DeleteGroup(ctx, f.auth, f.group.Group.ID, condition)
	default:
		panic("unknown SCIM mutation kind")
	}
	return err
}

func TestSCIMMutationRechecksTokenAfterWait(t *testing.T) {
	for _, kind := range scimMutationKinds {
		for _, change := range []string{"expiry", "revocation", "scope", "pairing"} {
			t.Run(kind+"/"+change, func(t *testing.T) {
				f := newSCIMVersionFixture(t)
				if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
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
				if _, err := blocker.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE`, f.auth.TokenID); err != nil {
					t.Fatal(err)
				}
				waiting := make(chan uint32, 1)
				var once sync.Once
				service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "scim_tokens") && (strings.Contains(sql, "FOR UPDATE") || strings.Contains(sql, "UPDATE scim_tokens") && strings.Contains(sql, "last_used_at")) {
						once.Do(func() { waiting <- conn.PgConn().PID() })
					}
				})
				done := make(chan error, 1)
				workers.Go(func() { done <- f.mutate(ctx, service, kind, nil) })
				select {
				case pid := <-waiting:
					waitForDatabaseLock(t, ctx, f.pool, pid)
					var owned bool
					if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&owned); err != nil || !owned {
						t.Fatalf("mutation did not wait for owned Token lock: %v", err)
					}
				case err := <-done:
					t.Fatalf("mutation bypassed Token wait: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				want := domain.ErrUnauthenticated
				switch change {
				case "expiry":
					f.advance(90 * 24 * time.Hour)
				case "revocation":
					_, err = blocker.Exec(ctx, `UPDATE scim_tokens SET revoked_at=$2 WHERE id=$1`, f.auth.TokenID, f.clock())
				case "scope":
					_, err = blocker.Exec(ctx, `UPDATE scim_tokens SET scopes='{scim:read}' WHERE id=$1`, f.auth.TokenID)
					want = domain.ErrForbidden
				case "pairing":
					_, err = blocker.Exec(ctx, `UPDATE scim_tokens SET oidc_provider_id=NULL WHERE id=$1`, f.auth.TokenID)
					want = domain.ErrForbidden
				}
				if err != nil {
					t.Fatal(err)
				}
				// Observe the lock owner's committed-to-be change while the
				// mutation's resource/usage/audit effects remain invisible.
				var before string
				query := strings.Replace(scimPairingSnapshotSQL, "to_jsonb(t)-'last_used_at'", "to_jsonb(t) || jsonb_build_object('xmin',t.xmin::text)", 1)
				if err := blocker.QueryRow(ctx, query).Scan(&before); err != nil {
					t.Fatal(err)
				}
				if err := blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err := <-done:
					if !errors.Is(err, want) || f.versionSnapshot(t) != before {
						t.Fatalf("stale Token admitted mutation or persisted effects: err=%v want=%v", err, want)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			})
		}
	}
}

func TestSCIMMutationRejectsInactiveOrganization(t *testing.T) {
	for _, kind := range scimMutationKinds {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			if _, err := f.pool.Exec(t.Context(), `UPDATE organizations SET active=FALSE WHERE id=$1`, f.auth.OrganizationID); err != nil {
				t.Fatal(err)
			}
			before := f.versionSnapshot(t)
			if err := f.mutate(t.Context(), f.service, kind, nil); !errors.Is(err, domain.ErrForbidden) || f.versionSnapshot(t) != before {
				t.Fatalf("cached authorization wrote into inactive Organization: %v", err)
			}
		})
	}
}

func TestSCIMMutationExpiryPrecedesConditionalEvaluation(t *testing.T) {
	for _, kind := range []string{"replace-user", "delete-user", "replace-group", "delete-group"} {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			f.advance(90 * 24 * time.Hour)
			before := f.versionSnapshot(t)
			if err := f.mutate(t.Context(), f.service, kind, scimVersionCondition(t, `W/"0"`)); !errors.Is(err, domain.ErrUnauthenticated) || f.versionSnapshot(t) != before {
				t.Fatalf("conditional response masked expired authority or wrote state: %v", err)
			}
		})
	}
}

func TestSCIMMutationRechecksExpiryAfterAuditWait(t *testing.T) {
	for _, kind := range scimMutationKinds {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			before := f.versionSnapshot(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(660021)`); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(ctx, `CREATE FUNCTION wait_scim_mutation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.event_type IN ('scim_user.created','scim_user.replaced','scim_user.deleted','scim_group.created','scim_group.replaced','scim_group.deleted')
				THEN PERFORM pg_advisory_xact_lock(660021); END IF; RETURN NEW; END $$;
				CREATE TRIGGER wait_scim_mutation_audit BEFORE INSERT ON identity_events FOR EACH ROW EXECUTE FUNCTION wait_scim_mutation_audit()`); err != nil {
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
			workers.Go(func() { done <- f.mutate(ctx, service, kind, nil) })
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
				var owned bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&owned); err != nil || !owned {
					t.Fatalf("mutation audit did not wait for owned barrier: %v", err)
				}
			case err := <-done:
				t.Fatalf("mutation bypassed audit wait: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.advance(90 * 24 * time.Hour)
			if err := blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, domain.ErrUnauthenticated) || f.versionSnapshot(t) != before {
					t.Fatalf("expired Token committed after audit wait: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestSCIMGroupMemberAdmissionWaitsForUserBeforeChildren(t *testing.T) {
	for _, kind := range []string{"create-group", "replace-group"} {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
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
			workers.Go(func() {
				input := scim.GroupInput{DisplayName: "Member admission", MemberIDs: []string{f.user.Membership.ID}}
				var err error
				if kind == "create-group" {
					_, err = service.CreateGroup(ctx, f.auth, input)
				} else {
					_, err = service.ReplaceGroup(ctx, f.auth, f.group.Group.ID, scim.ReplaceGroupInput{GroupInput: input})
				}
				done <- err
			})
			select {
			case pid := <-waiting:
				waitForDatabaseLock(t, ctx, f.pool, pid)
				var owned bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&owned); err != nil || !owned {
					t.Fatalf("member admission did not wait for owned User lock: %v", err)
				}
			case err := <-done:
				t.Fatalf("member admission bypassed User parent: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			probe, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, tokenErr := probe.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE NOWAIT`, f.auth.TokenID)
			_, groupErr := probe.Exec(ctx, `SELECT id FROM groups WHERE id=$1 FOR UPDATE NOWAIT`, f.group.Group.ID)
			_ = probe.Rollback(context.WithoutCancel(ctx))
			if tokenErr != nil || groupErr != nil {
				t.Fatalf("member wait holds child locks: token=%v group=%v", tokenErr, groupErr)
			}
			// Complete the deletion while owning its User parent. The waiting
			// writer must reread the Membership after acquiring that parent.
			if _, err := blocker.Exec(ctx, `DELETE FROM group_memberships WHERE organization_membership_id=$1`, f.user.Membership.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := blocker.Exec(ctx, `UPDATE organization_memberships SET active=FALSE,scim_deleted_at=$2 WHERE id=$1`, f.user.Membership.ID, f.clock()); err != nil {
				t.Fatal(err)
			}
			var before string
			query := strings.Replace(scimPairingSnapshotSQL, "to_jsonb(t)-'last_used_at'", "to_jsonb(t) || jsonb_build_object('xmin',t.xmin::text)", 1)
			if err := blocker.QueryRow(ctx, query).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, domain.ErrInvalidReference) || f.versionSnapshot(t) != before {
					t.Fatalf("deleted member accepted or refusal persisted state: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}
