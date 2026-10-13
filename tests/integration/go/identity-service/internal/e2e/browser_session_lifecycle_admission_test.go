package e2e

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestBrowserDirectoryMutationsRevalidateActorAfterTokenWait(t *testing.T) {
	for _, operation := range []string{"role", "user inactive"} {
		for _, invalidation := range []string{"logout", "expiry"} {
			t.Run(operation+"/"+invalidation, func(t *testing.T) {
				f := newBrowserControlsFixture(t)
				target := f.login(t, "admission", "member@example.com")
				actor := f.login(t, "admission", "admin@example.com")
				expires := f.clock().Add(5 * time.Second)
				if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at=$2 WHERE id=$1`, actor.TokenID, expires); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(f.caller(t, actor), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE`, target.TokenID); err != nil {
					t.Fatal(err)
				}
				pid := make(chan uint32, 1)
				var captured sync.Once
				store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "SELECT id FROM api_tokens") && strings.Contains(sql, "ORDER BY id FOR UPDATE") {
						captured.Do(func() { pid <- conn.PgConn().PID() })
					}
				})
				d := directory.NewService(store.Directory(), f.newID, f.clock, testPasswordEngine(t))
				done := make(chan error, 1)
				workers.Go(func() {
					if operation == "role" {
						_, err := d.UpdateMembership(ctx, directory.UpdateMembershipInput{RequestID: "expired-role-actor", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: domain.OrganizationRoleAdmin, Active: true})
						done <- err
					} else {
						done <- d.SetUserActive(ctx, directory.SetUserActiveInput{RequestID: "expired-disable-actor", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: false})
					}
				})
				assertBrowserBlocker(t, ctx, f, awaitBrowserPID(t, ctx, pid), blocker.Conn().PgConn().PID())
				if invalidation == "logout" {
					status, err := f.auth.RevokeByAccessToken(ctx, actor.AccessToken)
					if err != nil || status != localauth.RevokeStatusRevoked {
						t.Fatalf("actor logout did not commit during target wait: %v", err)
					}
				} else {
					f.now.Store(expires.UnixNano())
				}
				before := revocationStateSnapshot(t, f.localAdmissionFixture)
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if err := <-done; !errors.Is(err, callercontext.ErrInvalid) {
					t.Fatalf("invalid waiting administrator mutated target: %v", err)
				}
				if !reflect.DeepEqual(before, revocationStateSnapshot(t, f.localAdmissionFixture)) {
					t.Fatal("rejected administrator left business, audit or either feed effects")
				}
			})
		}
	}
}

func TestBrowserReactivationCannotReviveLegacyUnrevokedSessions(t *testing.T) {
	for _, source := range []string{"local", "scim"} {
		t.Run(source, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			second := f.otherOrganization(t)
			login := f.login(t, "admission", "member@example.com")
			other := f.login(t, second.Slug, "member@example.com")
			caller, err := callercontext.CallerFromContext(f.caller(t, login))
			if err != nil {
				t.Fatal(err)
			}
			// Model a pre-upgrade membership deactivation: historical code did not
			// persist token revocation. It must stay invalid after reactivation.
			if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET active=false,source=$2,scim_user_name=CASE WHEN $2='scim' THEN email ELSE NULL END WHERE id=$1`, f.user.Membership.ID, source); err != nil {
				t.Fatal(err)
			}
			if _, err := f.auth.Resolve(t.Context(), login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatal("legacy fixture is not inactive")
			}
			if source == "local" {
				_, err := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t)).UpdateMembership(t.Context(), directory.UpdateMembershipInput{RequestID: "reactivate-legacy", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: domain.OrganizationRoleMember, Active: true})
				if err != nil {
					t.Fatal(err)
				}
			} else {
				current, err := f.store.SCIM().GetUser(t.Context(), f.admin.Organization.ID, f.user.Membership.ID)
				if err != nil {
					t.Fatal(err)
				}
				membership := current.Membership
				membership.Active, membership.UpdatedAt = true, domain.NextUpdatedAt(f.clock(), membership.UpdatedAt)
				if _, err := f.store.SCIM().ReplaceUser(t.Context(), scim.ReplaceUserCommand{OrganizationID: f.admin.Organization.ID, User: current.User, Membership: membership, ExpectedUpdatedAt: current.Membership.UpdatedAt}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.auth.Resolve(t.Context(), login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatalf("reactivation revived the legacy browser credential: %v", err)
			}
			if _, err := caller.Revalidate(t.Context(), f.store.LocalAuth().ResolveSession); !errors.Is(err, callercontext.ErrInvalid) {
				t.Fatal("reactivation revived the old signed CCT")
			}
			if _, err := f.auth.Resolve(t.Context(), other.AccessToken); err != nil {
				t.Fatal("legacy retirement revoked an adjacent Organization")
			}
			var revoked, events int
			if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL),(SELECT count(*) FROM session_revocations WHERE reason='session_revoked')`).Scan(&revoked, &events); err != nil {
				t.Fatal(err)
			}
			if revoked != 1 || events != 1 {
				t.Fatal("reactivation did not persist prior loss of authority")
			}
			if len(readRevocations(t, f.localAdmissionFixture, 0, 500).Events) != 0 {
				t.Fatal("reactivation emitted a new principal offboarding event")
			}
		})
	}
}

func TestBrowserAdministratorCanDemoteOwnMembershipAndLosesSession(t *testing.T) {
	f := newBrowserControlsFixture(t)
	d := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t))
	input := directory.UpdateMembershipInput{RequestID: "promote-for-self-demotion", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: domain.OrganizationRoleAdmin, Active: true}
	if _, err := d.UpdateMembership(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	login := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	input.RequestID, input.ActorPrincipalID, input.Role = "self-demotion", f.user.User.ID, domain.OrganizationRoleMember
	if _, err := d.UpdateMembership(ctx, input); err != nil {
		t.Fatalf("authorized self-demotion revalidated after its own effects: %v", err)
	}
	if _, err := f.auth.Resolve(t.Context(), login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("self-demotion retained the administrator browser")
	}
	fresh := f.login(t, "admission", "member@example.com")
	if fresh.Principal.OrganizationRole != domain.OrganizationRoleMember {
		t.Fatal("fresh login retained old administrator role")
	}
}
