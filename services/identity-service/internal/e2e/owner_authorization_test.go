package e2e

import (
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/directory"
)

func TestOwnerAuthorizationRetainsScopedRevocationsAfterRestoration(t *testing.T) {
	f := revocationFixture(t)
	ctx := t.Context()
	service := directory.NewService(f.store.Directory(), f.newID, time.Now)
	other, err := service.CreateOrganization(ctx, directory.CreateOrganizationInput{
		RequestID: "other-org", ActorPrincipalID: f.admin.User.ID, Slug: "other", Name: "Other",
		OwnerEmail: "admin-other@example.com", OwnerDisplayName: "Admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "other-membership", ActorPrincipalID: f.admin.User.ID, OrganizationID: other.ID,
		UserID: f.user.User.ID, Email: "owner-other@example.com", DisplayName: "Owner", Role: f.user.Membership.Role,
	}); err != nil {
		t.Fatal(err)
	}
	assertState := func(active bool, sequence int64) {
		t.Helper()
		state, err := service.ResolveOwnerAuthorization(ctx, f.user.User.ID, f.admin.Organization.ID)
		if err != nil || state.Active != active || state.LastRevocationSequence != sequence || state.MembershipID != f.user.Membership.ID {
			t.Fatalf("authorization=%#v err=%v want active=%v seq=%d", state, err, active, sequence)
		}
	}
	assertState(true, 0)
	input := directory.UpdateMembershipInput{RequestID: "owner-membership", ActorPrincipalID: f.admin.User.ID,
		OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID,
		Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName, Role: f.user.Membership.Role}
	if _, err := service.UpdateMembership(ctx, input); err != nil {
		t.Fatal(err)
	}
	sequence := readRevocations(t, f, 0, 500).NextSequence
	assertState(false, sequence)
	otherState, err := service.ResolveOwnerAuthorization(ctx, f.user.User.ID, other.ID)
	if err != nil || !otherState.Active || otherState.LastRevocationSequence != 0 {
		t.Fatalf("organization-scoped revocation leaked: %#v err=%v", otherState, err)
	}
	input.Active = true
	if _, err := service.UpdateMembership(ctx, input); err != nil {
		t.Fatal(err)
	}
	assertState(true, sequence)
	for _, active := range []bool{false, true} {
		if err := service.SetUserActive(ctx, directory.SetUserActiveInput{RequestID: "owner-global", ActorPrincipalID: f.admin.User.ID,
			UserID: f.user.User.ID, Active: active}); err != nil {
			t.Fatal(err)
		}
		assertState(active, readRevocations(t, f, 0, 500).NextSequence)
		otherState, err := service.ResolveOwnerAuthorization(ctx, f.user.User.ID, other.ID)
		if err != nil || otherState.Active != active || otherState.LastRevocationSequence <= sequence {
			t.Fatalf("global revocation omitted: %#v err=%v", otherState, err)
		}
	}
}
