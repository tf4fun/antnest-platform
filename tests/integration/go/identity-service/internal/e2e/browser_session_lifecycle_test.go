package e2e

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

var browserLifecycleOperations = []struct {
	name, reason          string
	count, principalCount int
}{
	{"role", "role_changed", 2, 0},
	{"local inactive", "membership_deactivated", 2, 1},
	{"SCIM inactive", "membership_deactivated", 2, 1},
	{"SCIM delete", "membership_deleted", 2, 1},
	{"user inactive", "user_deactivated", 3, 1},
	{"logout", "session_revoked", 1, 0},
}

func browserLifecycleMutation(t *testing.T, f browserControlsFixture, operation string, login localauth.LoginResult) (func(context.Context) error, func(context.Context) error) {
	t.Helper()
	d := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t))
	localMembership := func(ctx context.Context, role domain.OrganizationRole, active bool) error {
		_, err := d.UpdateMembership(ctx, directory.UpdateMembershipInput{RequestID: "lifecycle-membership", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: role, Active: active})
		return err
	}
	noop := func(context.Context) error { return nil }
	switch operation {
	case "role":
		return func(ctx context.Context) error { return localMembership(ctx, domain.OrganizationRoleAdmin, true) }, func(ctx context.Context) error { return localMembership(ctx, domain.OrganizationRoleMember, true) }
	case "local inactive":
		return func(ctx context.Context) error { return localMembership(ctx, domain.OrganizationRoleMember, false) }, func(ctx context.Context) error { return localMembership(ctx, domain.OrganizationRoleMember, true) }
	case "user inactive":
		setActive := func(ctx context.Context, active bool) error {
			return d.SetUserActive(ctx, directory.SetUserActiveInput{RequestID: "lifecycle-user", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: active})
		}
		return func(ctx context.Context) error { return setActive(ctx, false) }, func(ctx context.Context) error { return setActive(ctx, true) }
	case "logout":
		return func(ctx context.Context) error {
			status, err := f.auth.RevokeByAccessToken(ctx, login.AccessToken)
			if err == nil && status != localauth.RevokeStatusRevoked {
				t.Fatalf("live logout status = %q", status)
			}
			return err
		}, noop
	case "SCIM inactive", "SCIM delete":
		if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET source = 'scim', scim_user_name = email, scim_external_id = 'lifecycle-member' WHERE id = $1`, f.user.Membership.ID); err != nil {
			t.Fatal(err)
		}
		seedRevocationGroup(t, f.localAdmissionFixture, f.user.Membership.ID)
		setActive := func(ctx context.Context, active bool) error {
			current, err := f.store.SCIM().GetUser(ctx, f.admin.Organization.ID, f.user.Membership.ID)
			if err != nil {
				return err
			}
			membership := current.Membership
			membership.Active, membership.UpdatedAt = active, domain.NextUpdatedAt(f.clock(), membership.UpdatedAt)
			_, err = f.store.SCIM().ReplaceUser(ctx, scim.ReplaceUserCommand{OrganizationID: f.admin.Organization.ID, User: current.User, Membership: membership, ExpectedUpdatedAt: current.Membership.UpdatedAt})
			return err
		}
		if operation == "SCIM inactive" {
			return func(ctx context.Context) error { return setActive(ctx, false) }, func(ctx context.Context) error { return setActive(ctx, true) }
		}
		return func(ctx context.Context) error {
				return f.store.SCIM().DeleteUser(ctx, scim.DeleteUserCommand{OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, DeletedAt: f.clock()})
			}, func(ctx context.Context) error {
				membership := f.user.Membership
				membership.ID, membership.Source, membership.SCIMExternalID, membership.SCIMUserName = f.newID("membership"), domain.SourceSCIM, "lifecycle-member", membership.Email
				membership.CreatedAt, membership.UpdatedAt = f.clock(), f.clock()
				resource, err := f.store.SCIM().CreateUser(ctx, scim.CreateUserCommand{OrganizationID: f.admin.Organization.ID, User: f.user.User, Membership: membership})
				if err == nil && (resource.User.ID != f.user.User.ID || resource.Membership.ID == f.user.Membership.ID) {
					t.Fatal("SCIM reprovision did not retain User with a fresh Membership")
				}
				return err
			}
	default:
		t.Fatalf("unknown lifecycle mutation %q", operation)
		return nil, nil
	}
}

func TestBrowserLifecycleRevokesPersistentlyWithCorrectScope(t *testing.T) {
	for _, operation := range browserLifecycleOperations {
		t.Run(operation.name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			second := f.otherOrganization(t)
			first := f.login(t, "admission", "member@example.com")
			sibling := f.login(t, "admission", "member@example.com")
			other := f.login(t, second.Slug, "member@example.com")
			admin := f.login(t, "admission", "admin@example.com")
			mutate, restore := browserLifecycleMutation(t, f, operation.name, first)
			if err := mutate(t.Context()); err != nil {
				t.Fatal(err)
			}
			page, err := f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{Limit: 500})
			if err != nil || len(page.Events) != operation.count {
				t.Fatalf("session feed events=%d want=%d: %v", len(page.Events), operation.count, err)
			}
			want := map[string]bool{first.TokenID: true}
			if operation.name != "logout" {
				want[sibling.TokenID] = true
			}
			if operation.name == "user inactive" {
				want[other.TokenID] = true
			}
			seen := map[string]bool{}
			for _, event := range page.Events {
				if !want[event.TokenID] || seen[event.TokenID] || event.UserID != f.user.User.ID || event.Reason != operation.reason {
					t.Fatal("session feed lost exact target, uniqueness, User or reason")
				}
				wantOrg := f.admin.Organization.ID
				if event.TokenID == other.TokenID {
					wantOrg = second.ID
				}
				if event.OrganizationID != wantOrg {
					t.Fatal("session feed lost organization binding")
				}
				seen[event.TokenID] = true
			}
			principal := readRevocations(t, f.localAdmissionFixture, 0, 500)
			if len(principal.Events) != operation.principalCount {
				t.Fatal("session-only change altered principal offboarding feed")
			}
			var revoked int
			if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL`).Scan(&revoked); err != nil || revoked != operation.count {
				t.Fatalf("revocation was not persisted: count=%d error=%v", revoked, err)
			}
			if err := restore(t.Context()); err != nil {
				t.Fatal(err)
			}
			for _, login := range []localauth.LoginResult{first, sibling, other, admin} {
				_, err := f.auth.Resolve(t.Context(), login.AccessToken)
				if want[login.TokenID] && !errors.Is(err, domain.ErrUnauthenticated) {
					t.Fatalf("restoring authority revived a revoked credential: %v", err)
				}
				if !want[login.TokenID] && err != nil {
					t.Fatalf("revocation escaped affected scope: %v", err)
				}
			}
			page, err = f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{Limit: 500})
			if err != nil || len(page.Events) != operation.count {
				t.Fatal("restoration duplicated session revocations")
			}
			if operation.name == "logout" {
				status, err := f.auth.RevokeByAccessToken(t.Context(), first.AccessToken)
				if err != nil || status != localauth.RevokeStatusAlreadyInvalid {
					t.Fatalf("repeated logout was not idempotent: %v", err)
				}
			}
		})
	}
}

func TestBrowserLifecycleSessionFeedFailureRollsBackBusinessAndPrincipalFeed(t *testing.T) {
	for _, operation := range browserLifecycleOperations {
		t.Run(operation.name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			first := f.login(t, "admission", "member@example.com")
			mutate, _ := browserLifecycleMutation(t, f, operation.name, first)
			before := revocationStateSnapshot(t, f.localAdmissionFixture)
			if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_session_feed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic feed failure'; END $$; CREATE TRIGGER reject_session_feed BEFORE INSERT ON session_revocations FOR EACH ROW EXECUTE FUNCTION reject_session_feed()`); err != nil {
				t.Fatal(err)
			}
			assertRevocationInsertFailure(t, mutate(t.Context()))
			if !reflect.DeepEqual(before, revocationStateSnapshot(t, f.localAdmissionFixture)) {
				t.Fatal("session feed failure left changed authority, token, audit, group or either feed")
			}
			if _, err := f.auth.Resolve(t.Context(), first.AccessToken); err != nil {
				t.Fatal("failed lifecycle mutation invalidated the original session")
			}
		})
	}
}

func TestBrowserMembershipProfileUpdateDoesNotRevoke(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	_, err := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t)).UpdateMembership(t.Context(), directory.UpdateMembershipInput{RequestID: "profile-only", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, Email: "renamed@example.com", DisplayName: "Renamed", Role: domain.OrganizationRoleMember, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth.Resolve(t.Context(), login.AccessToken); err != nil {
		t.Fatal("profile-only edit revoked the browser")
	}
	page, err := f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{Limit: 500})
	if err != nil || len(page.Events) != 0 {
		t.Fatal("profile-only edit emitted session revocation")
	}
}

func TestBrowserLogoutRejectsExpiredOrInactiveAuthority(t *testing.T) {
	for _, invalid := range []string{"idle", "absolute", "user", "organization", "membership"} {
		t.Run(invalid, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			var query string
			var args []any
			switch invalid {
			case "idle":
				query, args = `UPDATE api_tokens SET idle_expires_at = $2 WHERE id = $1`, []any{login.TokenID, f.clock()}
			case "absolute":
				query, args = `UPDATE api_tokens SET expires_at = $2 WHERE id = $1`, []any{login.TokenID, f.clock()}
			case "user":
				query, args = `UPDATE users SET active = false WHERE id = $1`, []any{f.user.User.ID}
			case "organization":
				query, args = `UPDATE organizations SET active = false WHERE id = $1`, []any{f.admin.Organization.ID}
			case "membership":
				query, args = `UPDATE organization_memberships SET active = false WHERE id = $1`, []any{f.user.Membership.ID}
			}
			if _, err := f.pool.Exec(t.Context(), query, args...); err != nil {
				t.Fatal(err)
			}
			before := revocationStateSnapshot(t, f.localAdmissionFixture)
			status, err := f.auth.RevokeByAccessToken(t.Context(), login.AccessToken)
			if err != nil || status != localauth.RevokeStatusAlreadyInvalid {
				t.Fatalf("invalid authority reported successful persistent logout: %q %v", status, err)
			}
			if !reflect.DeepEqual(before, revocationStateSnapshot(t, f.localAdmissionFixture)) {
				t.Fatal("invalid authority mutated session or feed")
			}
		})
	}
}
