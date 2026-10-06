package e2e

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestPrincipalRevocationsMembershipMutationsAreAtomic(t *testing.T) {
	for _, operation := range []string{"local inactive", "SCIM inactive", "SCIM delete"} {
		t.Run(operation, func(t *testing.T) {
			f := revocationFixture(t)
			user := newRevocationSCIMUser(t, f)
			seedRevocationGroup(t, f, user.Membership.ID)
			before := revocationStateSnapshot(t, f)
			if _, err := f.pool.Exec(t.Context(), `
				CREATE FUNCTION reject_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'synthetic feed failure'; END $$;
				CREATE TRIGGER reject_revocation BEFORE INSERT ON principal_revocations
				FOR EACH ROW EXECUTE FUNCTION reject_revocation()`); err != nil {
				t.Fatal(err)
			}
			assertRevocationInsertFailure(t, failingRevocationMutation(t, f, user, operation))
			if after := revocationStateSnapshot(t, f); !reflect.DeepEqual(before, after) {
				t.Fatal("failed feed append changed identity, tokens, audit, groups, memberships or feed")
			}
		})
	}
}

func assertRevocationInsertFailure(t *testing.T, err error) {
	t.Helper()
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "P0001" || databaseError.Message != "synthetic feed failure" {
		t.Fatalf("wanted injected feed failure, got %v", err)
	}
}

func failingRevocationMutation(t *testing.T, f localAdmissionFixture, user scim.UserResource, operation string) error {
	t.Helper()
	ctx := t.Context()
	switch operation {
	case "local inactive":
		membership := f.user.Membership
		membership.Active = false
		membership.UpdatedAt = domain.NextUpdatedAt(time.Now(), membership.UpdatedAt)
		_, err := f.store.Directory().UpdateMembership(ctx, directory.UpdateMembershipCommand{
			RequestID: "failed-local-revocation", ActorPrincipalID: f.admin.User.ID,
			Membership: membership, ExpectedUpdatedAt: f.user.Membership.UpdatedAt,
		})
		return err
	case "SCIM inactive":
		command := scim.ReplaceUserCommand{OrganizationID: f.admin.Organization.ID,
			User: user.User, Membership: user.Membership, ExpectedUpdatedAt: user.Membership.UpdatedAt}
		command.Membership.Active = false
		command.Membership.UpdatedAt = domain.NextUpdatedAt(time.Now(), user.Membership.UpdatedAt)
		command.User.UpdatedAt = command.Membership.UpdatedAt
		_, err := f.store.SCIM().ReplaceUser(ctx, command)
		return err
	case "SCIM delete":
		return f.store.SCIM().DeleteUser(ctx, scim.DeleteUserCommand{
			OrganizationID: f.admin.Organization.ID, MembershipID: user.Membership.ID, DeletedAt: time.Now(),
		})
	default:
		t.Fatalf("unknown test mutation %q", operation)
		return nil
	}
}

func seedRevocationGroup(t *testing.T, f localAdmissionFixture, membershipID string) {
	t.Helper()
	now := storedNow()
	_, err := f.store.SCIM().CreateGroup(t.Context(), scim.CreateGroupCommand{
		OrganizationID: f.admin.Organization.ID,
		Group: domain.Group{ID: f.newID("group"), OrganizationID: f.admin.Organization.ID,
			DisplayName: "SCIM group", Source: domain.SourceSCIM, Active: true,
			SCIMExternalID: "revocation-group", CreatedAt: now, UpdatedAt: now},
		MemberIDs: []string{membershipID},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func revocationStateSnapshot(t *testing.T, f localAdmissionFixture) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	for _, table := range []string{"users", "organization_memberships", "groups", "group_memberships", "api_tokens", "identity_events", "principal_revocations"} {
		var value string
		query := fmt.Sprintf(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text), '[]'::jsonb)::text FROM (SELECT to_jsonb(t) AS row FROM %s t) rows`, pgx.Identifier{table}.Sanitize())
		if err := f.pool.QueryRow(t.Context(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		snapshot[table] = value
	}
	return snapshot
}
