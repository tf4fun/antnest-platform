package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestExternalIdentityExistingWritersLockParentsBeforeMembership(t *testing.T) {
	for _, operation := range []string{"add-membership", "scim-reprovision"} {
		t.Run(operation, func(t *testing.T) {
			f := newBindingFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			var targetUser, probeMembership string
			var add directory.AddOrganizationMembershipInput
			var create scim.CreateUserCommand
			if operation == "add-membership" {
				if _, err := f.pool.Exec(ctx, `UPDATE organization_memberships SET role='admin' WHERE id=$1`, f.user.Membership.ID); err != nil {
					t.Fatal(err)
				}
				other, err := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t)).CreateLocalUser(ctx, directory.CreateLocalUserInput{RequestID: "other-member", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Email: "other@example.com", DisplayName: "Other", Password: "correct horse battery staple", Role: domain.OrganizationRoleMember})
				if err != nil {
					t.Fatal(err)
				}
				targetUser, probeMembership = other.User.ID, f.user.Membership.ID
				add = directory.AddOrganizationMembershipInput{RequestID: "idempotent-add", ActorPrincipalID: f.user.User.ID, OrganizationID: f.admin.Organization.ID, UserID: other.User.ID, Email: other.Membership.Email, DisplayName: other.Membership.DisplayName, Role: other.Membership.Role}
			} else {
				old := newRevocationSCIMUser(t, f.localAdmissionFixture)
				if err := f.store.SCIM().DeleteUser(ctx, scim.DeleteUserCommand{OrganizationID: f.admin.Organization.ID, MembershipID: old.Membership.ID, DeletedAt: f.clock()}); err != nil {
					t.Fatal(err)
				}
				targetUser, probeMembership = old.User.ID, old.Membership.ID
				create = scim.CreateUserCommand{OrganizationID: f.admin.Organization.ID, User: old.User, Membership: old.Membership}
				create.User.ID = f.newID("user")
				create.Membership.ID = f.newID("membership")
				create.Membership.UserID = create.User.ID
			}
			blocker, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
			if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, targetUser); err != nil {
				t.Fatal(err)
			}
			attempted := make(chan uint32, 1)
			var once sync.Once
			store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR ") || strings.Contains(sql, "FOR UPDATE OF m, u") {
					once.Do(func() { attempted <- conn.PgConn().PID() })
				}
			})
			done := make(chan error, 1)
			workers.Go(func() {
				if operation == "add-membership" {
					_, err := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t)).AddOrganizationMembership(ctx, add)
					done <- err
					return
				}
				result, err := store.SCIM().CreateUser(ctx, create)
				if err == nil && result.User.ID != targetUser {
					err = domain.ErrConflict
				}
				done <- err
			})
			select {
			case pid := <-attempted:
				waitForDatabaseLock(t, ctx, f.pool, pid)
			case err := <-done:
				t.Fatalf("writer skipped parent lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			probe, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, lockErr := probe.Exec(ctx, `SELECT id FROM organization_memberships WHERE id=$1 FOR UPDATE NOWAIT`, probeMembership)
			_ = probe.Rollback(context.WithoutCancel(ctx))
			if lockErr != nil {
				t.Fatalf("%s held a Membership while blocked on its User parent: %v", operation, lockErr)
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
		})
	}
}
