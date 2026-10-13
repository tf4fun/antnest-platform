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

func TestSCIMMutationRechecksOrganizationAfterWait(t *testing.T) {
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
			if _, err := blocker.Exec(ctx, `SELECT id FROM organizations WHERE id=$1 FOR UPDATE`, f.auth.OrganizationID); err != nil {
				t.Fatal(err)
			}
			waiting := make(chan uint32, 1)
			var once sync.Once
			service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM organizations") && strings.Contains(sql, "FOR SHARE") {
					once.Do(func() { waiting <- conn.PgConn().PID() })
				}
			})
			done := make(chan error, 1)
			workers.Go(func() { done <- f.mutate(ctx, service, kind, nil) })
			select {
			case pid := <-waiting:
				if finished, err := waitSCIMLineageRival(t, ctx, f.pool, pid, blocker.Conn().PgConn().PID(), done); finished {
					t.Fatalf("mutation bypassed Organization owner: %v", err)
				}
			case err := <-done:
				t.Fatalf("mutation bypassed Organization lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if _, err := blocker.Exec(ctx, `UPDATE organizations SET active=FALSE WHERE id=$1`, f.auth.OrganizationID); err != nil {
				t.Fatal(err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, domain.ErrForbidden) || f.versionSnapshot(t) != before {
					t.Fatalf("inactive Organization admitted write: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestSCIMMutationExpiryAfterFinalFeedWaitRollsBackEverything(t *testing.T) {
	for _, kind := range []string{"replace-user", "delete-user"} {
		for _, table := range []string{"principal_revocations", "session_revocations"} {
			t.Run(kind+"/"+table, func(t *testing.T) {
				f := newSCIMVersionFixture(t)
				login, err := f.flow.CompleteLogin(t.Context(), f.start(t))
				if err != nil || login.Principal.UserID != f.user.User.ID {
					t.Fatalf("paired browser fixture: %v", err)
				}
				before := f.versionSnapshot(t)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, "LOCK TABLE "+table+" IN SHARE ROW EXCLUSIVE MODE"); err != nil {
					t.Fatal(err)
				}
				waiting := make(chan uint32, 1)
				var once sync.Once
				service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "LOCK TABLE "+table) {
						once.Do(func() { waiting <- conn.PgConn().PID() })
					}
				})
				done := make(chan error, 1)
				workers.Go(func() { done <- f.mutate(ctx, service, kind, nil) })
				select {
				case pid := <-waiting:
					if finished, err := waitSCIMLineageRival(t, ctx, f.pool, pid, blocker.Conn().PgConn().PID(), done); finished {
						t.Fatalf("mutation bypassed feed owner: %v", err)
					}
				case err := <-done:
					t.Fatalf("mutation bypassed final feed: %v", err)
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
						t.Fatalf("expiry after feed wait persisted resource/Token/SID/audit/feed: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			})
		}
	}
}

func TestSCIMGroupMemberDeletionSerializesInBothOrders(t *testing.T) {
	for _, kind := range []string{"create", "replace"} {
		for _, first := range []string{"group", "delete"} {
			t.Run(kind+"/"+first+"-first", func(t *testing.T) {
				f := newSCIMVersionFixture(t)
				// Begin without a reference. The writer must not add one after a
				// concurrent tombstone, and deletion must see a preceding insert.
				group, err := f.service.ReplaceGroup(t.Context(), f.auth, f.group.Group.ID, scim.ReplaceGroupInput{GroupInput: scim.GroupInput{DisplayName: "Empty group"}})
				if err != nil {
					t.Fatal(err)
				}
				f.group = group
				var groupAudits int
				if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM identity_events WHERE event_type IN ('scim_group.created','scim_group.replaced')`).Scan(&groupAudits); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				release := make(chan struct{})
				ownerPID, rivalPID := make(chan uint32, 1), make(chan uint32, 1)
				var groupOnce, deleteOnce sync.Once
				writer := tracedSCIMPairing(t, f.bindingFixture, func(ctx context.Context, conn *pgx.Conn, sql string) {
					if first == "group" && strings.Contains(sql, "INSERT INTO group_memberships") {
						groupOnce.Do(func() {
							ownerPID <- conn.PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
							}
						})
					} else if first == "delete" && strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR SHARE") {
						groupOnce.Do(func() { rivalPID <- conn.PgConn().PID() })
					}
				})
				deleter := tracedSCIMPairing(t, f.bindingFixture, func(ctx context.Context, conn *pgx.Conn, sql string) {
					if first == "delete" && strings.Contains(sql, "UPDATE organization_memberships") && strings.Contains(sql, "scim_deleted_at") {
						deleteOnce.Do(func() {
							ownerPID <- conn.PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
							}
						})
					} else if first == "group" && strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR UPDATE") {
						deleteOnce.Do(func() { rivalPID <- conn.PgConn().PID() })
					}
				})
				writeDone, deleteDone := make(chan error, 1), make(chan error, 1)
				var written scim.GroupResource
				write := func() {
					input := scim.GroupInput{DisplayName: "Race group", MemberIDs: []string{f.user.Membership.ID}}
					var err error
					if kind == "create" {
						written, err = writer.CreateGroup(ctx, f.auth, input)
					} else {
						written, err = writer.ReplaceGroup(ctx, f.auth, f.group.Group.ID, scim.ReplaceGroupInput{GroupInput: input})
					}
					writeDone <- err
				}
				remove := func() { deleteDone <- deleter.DeleteUser(ctx, f.auth, f.user.Membership.ID, nil) }
				ownerWork, rivalWork := write, remove
				ownerDone, rivalDone := writeDone, deleteDone
				if first == "delete" {
					ownerWork, rivalWork = remove, write
					ownerDone, rivalDone = deleteDone, writeDone
				}
				workers.Go(ownerWork)
				var owner uint32
				select {
				case owner = <-ownerPID:
				case err := <-ownerDone:
					t.Fatalf("first mutation bypassed barrier: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Go(rivalWork)
				select {
				case rival := <-rivalPID:
					if finished, err := waitSCIMLineageRival(t, ctx, f.pool, rival, owner, rivalDone); finished {
						t.Fatalf("rival bypassed parent lock: %v", err)
					}
				case err := <-rivalDone:
					t.Fatalf("rival completed while first held parents: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				close(release)
				select {
				case err := <-deleteDone:
					if err != nil {
						t.Fatal(err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				select {
				case err := <-writeDone:
					if first == "group" && err != nil || first == "delete" && !errors.Is(err, domain.ErrInvalidReference) {
						t.Fatalf("unexpected serialized Group result: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				var references, afterAudits int
				var deleted bool
				if err := f.pool.QueryRow(ctx, `SELECT
					(SELECT count(*) FROM group_memberships WHERE organization_membership_id=$1),
					(SELECT scim_deleted_at IS NOT NULL FROM organization_memberships WHERE id=$1),
					(SELECT count(*) FROM identity_events WHERE event_type IN ('scim_group.created','scim_group.replaced'))`, f.user.Membership.ID).Scan(&references, &deleted, &afterAudits); err != nil {
					t.Fatal(err)
				}
				if first == "group" {
					groupAudits++
				}
				if references != 0 || !deleted || afterAudits != groupAudits {
					t.Fatalf("deleted User reference or refused Group audit persisted: refs=%d deleted=%v audits=%d want=%d", references, deleted, afterAudits, groupAudits)
				}
				if first == "group" {
					after, err := f.service.GetGroup(ctx, f.auth, written.Group.ID)
					if err != nil || len(after.MemberIDs) != 0 || !after.Group.UpdatedAt.After(written.Group.UpdatedAt) {
						t.Fatalf("deletion did not advance the inserted Group version: %v", err)
					}
				}
			})
		}
	}
}
