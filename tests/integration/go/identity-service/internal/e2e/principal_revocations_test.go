package e2e

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func revocationFixture(t *testing.T) localAdmissionFixture {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	return newLocalAdmissionFixture(t, databaseURL, time.Now)
}

func TestPrincipalRevocationsLocalTransitionsAndReplay(t *testing.T) {
	f := revocationFixture(t)
	service := directory.NewService(f.store.Directory(), f.newID, time.Now)
	ctx := trace.ContextWithSpanContext(t.Context(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled,
	}))
	input := directory.UpdateMembershipInput{
		RequestID: "membership-update", ActorPrincipalID: f.admin.User.ID,
		OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID,
		Email: f.user.Membership.Email, DisplayName: "Updated member", Role: domain.OrganizationRoleMember,
	}
	for _, active := range []bool{true, false, false, true} {
		input.Active = active
		if _, err := service.UpdateMembership(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	for _, active := range []bool{false, false, true} {
		if err := service.SetUserActive(ctx, directory.SetUserActiveInput{
			RequestID: "user-update", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: active,
		}); err != nil {
			t.Fatal(err)
		}
	}
	page := readRevocations(t, f, 0, 500)
	if len(page.Events) != 2 {
		t.Fatalf("wanted membership + global deactivation only: %#v", page)
	}
	first, second := page.Events[0], page.Events[1]
	if first.UserID != f.user.User.ID || first.OrganizationID != f.admin.Organization.ID || first.Reason != "membership_deactivated" || first.TraceParent == "" {
		t.Fatalf("membership event=%#v", first)
	}
	if second.UserID != f.user.User.ID || second.OrganizationID != "" || second.Reason != "user_deactivated" || second.Sequence <= first.Sequence {
		t.Fatalf("global event=%#v", second)
	}
	if replay := readRevocations(t, f, 0, 500); !reflect.DeepEqual(page, replay) {
		t.Fatalf("replay changed: %#v", replay)
	}
	if one := readRevocations(t, f, 0, 1); len(one.Events) != 1 || one.NextSequence != first.Sequence {
		t.Fatalf("bounded first page=%#v", one)
	}
	if next := readRevocations(t, f, first.Sequence, 1); len(next.Events) != 1 || next.NextSequence != second.Sequence {
		t.Fatalf("exclusive cursor=%#v", next)
	}
	if empty := readRevocations(t, f, second.Sequence, 1); empty.Events == nil || len(empty.Events) != 0 || empty.NextSequence != second.Sequence {
		t.Fatalf("empty page=%#v", empty)
	}
}

func TestPrincipalRevocationsSCIMTransitions(t *testing.T) {
	f := revocationFixture(t)
	ctx := t.Context()
	resource := newRevocationSCIMUser(t, f)
	var err error
	for _, active := range []bool{false, false, true} {
		command := scim.ReplaceUserCommand{OrganizationID: f.admin.Organization.ID,
			User: resource.User, Membership: resource.Membership, ExpectedUpdatedAt: resource.Membership.UpdatedAt}
		command.Membership.Active = active
		command.Membership.UpdatedAt = domain.NextUpdatedAt(time.Now(), resource.Membership.UpdatedAt)
		command.User.UpdatedAt = command.Membership.UpdatedAt
		resource, err = f.store.SCIM().ReplaceUser(ctx, command)
		if err != nil {
			t.Fatal(err)
		}
	}
	command := scim.DeleteUserCommand{OrganizationID: f.admin.Organization.ID, MembershipID: resource.Membership.ID, DeletedAt: time.Now()}
	if err := f.store.SCIM().DeleteUser(ctx, command); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SCIM().DeleteUser(ctx, command); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("repeated delete=%v", err)
	}
	page := readRevocations(t, f, 0, 500)
	if len(page.Events) != 2 || page.Events[0].Reason != "membership_deactivated" || page.Events[1].Reason != "membership_deleted" {
		t.Fatalf("SCIM events=%#v", page)
	}
	for _, event := range page.Events {
		if event.UserID != resource.User.ID || event.OrganizationID != f.admin.Organization.ID {
			t.Fatalf("SCIM scope=%#v", event)
		}
	}
}

func newRevocationSCIMUser(t *testing.T, f localAdmissionFixture) scim.UserResource {
	t.Helper()
	now := storedNow()
	userID := f.newID("user")
	resource, err := f.store.SCIM().CreateUser(t.Context(), scim.CreateUserCommand{
		OrganizationID: f.admin.Organization.ID,
		User:           domain.User{ID: userID, SystemRole: domain.SystemRoleUser, Active: true, CreatedAt: now, UpdatedAt: now},
		Membership: domain.OrganizationMembership{
			ID: f.newID("membership"), UserID: userID, OrganizationID: f.admin.Organization.ID, Email: "scim@example.com",
			DisplayName: "SCIM member", Role: domain.OrganizationRoleMember, Source: domain.SourceSCIM,
			Active: true, SCIMExternalID: "external-member", SCIMUserName: "scim-member", CreatedAt: now, UpdatedAt: now,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return resource
}

func TestPrincipalRevocationsFailureRollsBackMutationAndAudit(t *testing.T) {
	f := revocationFixture(t)
	ctx := t.Context()
	var before int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM identity_events`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `
		CREATE FUNCTION reject_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'synthetic feed failure'; END $$;
		CREATE TRIGGER reject_revocation BEFORE INSERT ON principal_revocations
		FOR EACH ROW EXECUTE FUNCTION reject_revocation()`); err != nil {
		t.Fatal(err)
	}
	err := f.store.Directory().SetUserActive(ctx, directory.SetUserActiveCommand{
		RequestID: "failed-revocation", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, UpdatedAt: time.Now(),
	})
	assertRevocationInsertFailure(t, err)
	var active bool
	var after int
	if err := f.pool.QueryRow(ctx, `SELECT active, (SELECT count(*) FROM identity_events) FROM users WHERE id=$1`, f.user.User.ID).Scan(&active, &after); err != nil {
		t.Fatal(err)
	}
	if !active || before != after || len(readRevocations(t, f, 0, 500).Events) != 0 {
		t.Fatalf("partial mutation: active=%v audits before=%d after=%d", active, before, after)
	}
}

func TestPrincipalRevocationsCommitOrderAndRollbackGaps(t *testing.T) {
	t.Run("committed predecessor", func(t *testing.T) { checkRevocationCommitOrder(t, true) })
	t.Run("rolled back predecessor", func(t *testing.T) { checkRevocationCommitOrder(t, false) })
}

func checkRevocationCommitOrder(t *testing.T, commitFirst bool) {
	f := revocationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := first.Exec(ctx, `LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	var rolledBackSequence int64
	if err := first.QueryRow(ctx, `INSERT INTO principal_revocations(user_id, reason, occurred_at)
		VALUES ($1, 'user_deactivated', now()) RETURNING sequence`, f.admin.User.ID).Scan(&rolledBackSequence); err != nil {
		t.Fatal(err)
	}
	blocked := make(chan uint32, 1)
	traced := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, query string) {
		if query == "LOCK TABLE principal_revocations IN SHARE ROW EXCLUSIVE MODE" {
			blocked <- conn.PgConn().PID()
		}
	})
	done := make(chan error, 1)
	finished := make(chan struct{})
	defer func() {
		cancel()
		<-finished
	}()
	go func() {
		defer close(finished)
		done <- traced.Directory().SetUserActive(ctx, directory.SetUserActiveCommand{
			RequestID: "ordered-revocation", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, UpdatedAt: time.Now(),
		})
	}()
	select {
	case pid := <-blocked:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case <-ctx.Done():
		t.Fatal("writer never reached feed lock")
	}
	var allocated int64
	if err := f.pool.QueryRow(ctx, `SELECT last_value FROM principal_revocations_sequence_seq`).Scan(&allocated); err != nil {
		t.Fatal(err)
	}
	if allocated != rolledBackSequence {
		t.Fatal("blocked writer allocated a sequence before obtaining the lock")
	}
	if page := readRevocations(t, f, 0, 500); len(page.Events) != 0 || page.NextSequence != 0 {
		t.Fatalf("uncommitted event or sequence escaped: %#v", page)
	}
	if err := finishRevocationPredecessor(ctx, first, commitFirst); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	page := readRevocations(t, f, 0, 500)
	if commitFirst {
		if len(page.Events) != 2 || page.Events[0].Sequence != rolledBackSequence {
			t.Fatalf("committed predecessor was lost: %#v", page)
		}
		page = readRevocations(t, f, rolledBackSequence, 500)
	}
	if len(page.Events) != 1 || page.Events[0].Sequence <= rolledBackSequence || page.Events[0].UserID != f.user.User.ID {
		t.Fatalf("committed page after rollback=%#v", page)
	}
}

func finishRevocationPredecessor(ctx context.Context, tx pgx.Tx, commit bool) error {
	if commit {
		return tx.Commit(ctx)
	}
	return tx.Rollback(ctx)
}

func readRevocations(t *testing.T, f localAdmissionFixture, after int64, limit int) domain.PrincipalRevocationPage {
	t.Helper()
	page, err := f.store.Directory().ListPrincipalRevocations(t.Context(), directory.RevocationQuery{AfterSequence: after, Limit: limit})
	if err != nil {
		t.Fatal(err)
	}
	return page
}
