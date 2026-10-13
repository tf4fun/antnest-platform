package e2e

import (
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

func (f bindingFixture) additionalProvider(t *testing.T, organizationID, name string) oidcflow.Provider {
	t.Helper()
	p, err := f.store.OIDC().FindProvider(t.Context(), f.admin.Organization.ID, "workforce")
	if err != nil {
		t.Fatal(err)
	}
	p.ID, p.OrganizationID, p.Name, p.DisplayName, p.Revision = f.newID("provider"), organizationID, name, name, 1
	p.Issuer += "/" + name
	if _, err := f.store.OIDC().UpsertProvider(t.Context(), oidcflow.UpsertProviderCommand{RequestID: "additional-provider", ActorPrincipalID: f.admin.User.ID, Provider: p}); err != nil {
		t.Fatal(err)
	}
	return p.Provider
}

func TestExternalIdentityIndependentPaginationSurvivesAcknowledgement(t *testing.T) {
	f := newBindingFixture(t)
	// Historical fixtures exceed the public maximum page size. Notice IDs have
	// a different order from binding IDs, so a shared cursor cannot pass.
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO external_identities (id,organization_id,provider_id,user_id,membership_id,subject,method,created_at,bound_at,updated_at,revoked_at)
		SELECT 'page-binding-'||lpad(n::text,3,'0'),$1,$2,$3,$4,'subject-'||n,'admin',$5,$5,$5,$5 FROM generate_series(1,105) n`, f.admin.Organization.ID, f.providerID, f.user.User.ID, f.user.Membership.ID, f.clock()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO external_identity_notices (id,user_id,binding_id,provider_id,provider_name,provider_display_name,organization_id,organization_slug,organization_name,membership_id,subject,method,created_at)
		SELECT 'page-notice-'||lpad((106-n)::text,3,'0'),e.user_id,e.id,e.provider_id,p.name,p.display_name,e.organization_id,o.slug,o.name,e.membership_id,e.subject,e.method,e.created_at
		FROM generate_series(1,105) n JOIN external_identities e ON e.id='page-binding-'||lpad(n::text,3,'0') JOIN oidc_providers p ON p.id=e.provider_id JOIN organizations o ON o.id=e.organization_id`); err != nil {
		t.Fatal(err)
	}
	query := externalidentities.ListInput{ActorPrincipalID: f.user.User.ID, Scope: "self", Limit: 100}
	before := f.snapshot(t)
	first, err := f.controls.List(f.selfCtx, query)
	if err != nil || len(first.Bindings) != 100 || first.Notices == nil || len(*first.Notices) != 100 || first.NextAfterID != "page-binding-100" || first.NextNoticeAfterID != "page-notice-100" || f.snapshot(t) != before {
		t.Fatalf("first independent page: %+v %v", first, err)
	}
	ids := make([]string, 0, 100)
	for _, notice := range *first.Notices {
		ids = append(ids, notice.ID)
	}
	ack, err := f.controls.Acknowledge(f.selfCtx, externalidentities.AcknowledgeInput{RequestID: "page-ack", ActorPrincipalID: f.user.User.ID, NoticeIDs: ids})
	if err != nil || ack.AcknowledgedCount != 100 {
		t.Fatalf("page acknowledgement: %+v %v", ack, err)
	}
	query.AfterID, query.NoticeAfterID = first.NextAfterID, first.NextNoticeAfterID
	last, err := f.controls.List(f.selfCtx, query)
	if err != nil || len(last.Bindings) != 5 || last.Notices == nil || len(*last.Notices) != 5 || last.NextAfterID != "" || last.NextNoticeAfterID != "" {
		t.Fatalf("terminal page after ACK: %+v %v", last, err)
	}
	if last.Bindings[0].ID != "page-binding-101" || (*last.Notices)[0].BindingID != "page-binding-005" {
		t.Fatal("binding and notice cursor streams were coupled")
	}
	query.AfterID = "page-binding-105"
	remaining, err := f.controls.List(f.selfCtx, query)
	if err != nil || len(remaining.Bindings) != 0 || remaining.Notices == nil || len(*remaining.Notices) != 5 {
		t.Fatalf("exhausted binding cursor hid pending notices: %+v %v", remaining, err)
	}
	org, err := f.controls.List(f.adminCtx, externalidentities.ListInput{ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: f.user.Membership.ID, Limit: 100})
	if err != nil || len(org.Bindings) != 100 || org.Notices != nil || org.NextAfterID != "page-binding-100" || org.NextNoticeAfterID != "" {
		t.Fatalf("organization inventory: %+v %v", org, err)
	}
}

func TestExternalIdentityOldAcknowledgementCannotHideRestorationNotice(t *testing.T) {
	f := newBindingFixture(t)
	binding := f.bind(t)
	query := externalidentities.ListInput{ActorPrincipalID: f.user.User.ID, Scope: "self", Limit: 100}
	page, err := f.controls.List(f.selfCtx, query)
	if err != nil || page.Notices == nil || len(*page.Notices) != 1 {
		t.Fatalf("initial notice: %v", err)
	}
	old := (*page.Notices)[0]
	if _, err := f.controls.Unbind(f.adminCtx, f.unbindInput(binding.ID)); err != nil {
		t.Fatal(err)
	}
	restore := f.bindInput()
	restore.RestoreRevoked = true
	if _, err := f.controls.Bind(f.adminCtx, restore); err != nil {
		t.Fatal(err)
	}
	f.selfCtx = f.browser.caller(t, f.browser.login(t, "admission", "member@example.com"))
	for _, want := range []int{1, 0} {
		ack, err := f.controls.Acknowledge(f.selfCtx, externalidentities.AcknowledgeInput{RequestID: "old-notice", ActorPrincipalID: f.user.User.ID, NoticeIDs: []string{old.ID}})
		if err != nil || ack.AcknowledgedCount != want {
			t.Fatalf("old notice acknowledgement: %+v %v", ack, err)
		}
	}
	page, err = f.controls.List(f.selfCtx, query)
	if err != nil || page.Notices == nil || len(*page.Notices) != 1 || (*page.Notices)[0].ID == old.ID || (*page.Notices)[0].BindingID != binding.ID {
		t.Fatalf("old acknowledgement hid restored notice: %+v %v", page, err)
	}
}

func TestExternalIdentityCrossOrganizationScopeAndRevocation(t *testing.T) {
	f := newBindingFixture(t)
	first := f.bind(t)
	second := f.browser.otherOrganization(t)
	otherLogin := f.browser.login(t, second.Slug, "member@example.com")
	otherAdmin := f.browser.caller(t, f.browser.login(t, second.Slug, "admin@example.com"))
	p := f.additionalProvider(t, second.ID, "other-workforce")
	input := f.bindInput()
	input.MembershipID = otherLogin.Principal.MembershipID
	input.ProviderID = p.ID
	before := f.snapshot(t)
	if _, err := f.controls.Bind(f.adminCtx, input); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("cross-org Membership admitted: %v", err)
	}
	input.MembershipID = f.user.Membership.ID
	if _, err := f.controls.Bind(f.adminCtx, input); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("cross-org Provider admitted: %v", err)
	}
	input.MembershipID = otherLogin.Principal.MembershipID
	otherBinding, err := f.controls.Bind(otherAdmin, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.controls.List(f.adminCtx, externalidentities.ListInput{ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: input.MembershipID, Limit: 100}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-org inventory disclosed: %v", err)
	}
	page, err := f.controls.List(f.selfCtx, externalidentities.ListInput{ActorPrincipalID: f.user.User.ID, Scope: "self", Limit: 100})
	if err != nil || len(page.Bindings) != 2 || page.Notices == nil || len(*page.Notices) != 2 {
		t.Fatalf("self cross-org inventory missing: %+v %v", page, err)
	}
	chooser, err := f.controls.ListProviders(f.adminCtx, externalidentities.ProvidersInput{ActorPrincipalID: f.admin.User.ID, Limit: 100})
	if err != nil || len(chooser.Providers) != 1 || chooser.Providers[0].ID != f.providerID {
		t.Fatalf("chooser exposed foreign Provider: %+v %v", chooser, err)
	}
	result, err := f.controls.Unbind(f.selfCtx, externalidentities.UnbindInput{RequestID: "cross-org-self", ActorPrincipalID: f.user.User.ID, Scope: "self", BindingID: otherBinding.ID})
	if err != nil || result.CurrentRevoked || result.RevokedCount != 1 {
		t.Fatalf("cross-org self result: %+v %v", result, err)
	}
	var ownActive, otherRevoked, firstActive bool
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT revoked_at IS NULL FROM api_tokens WHERE id=$1),(SELECT revoked_at IS NOT NULL FROM api_tokens WHERE id=$2),(SELECT revoked_at IS NULL FROM external_identities WHERE id=$3)`, f.selfTokenID, otherLogin.TokenID, first.ID).Scan(&ownActive, &otherRevoked, &firstActive); err != nil {
		t.Fatal(err)
	}
	if !ownActive || !otherRevoked || !firstActive {
		t.Fatal("cross-org self unbind revoked outside exact Membership")
	}
	var foreignFeed, offboarding int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM session_revocations WHERE organization_id<>$1),(SELECT count(*) FROM principal_revocations)`, second.ID).Scan(&foreignFeed, &offboarding); err != nil {
		t.Fatal(err)
	}
	if foreignFeed != 0 || offboarding != 0 {
		t.Fatal("cross-org unbind emitted unrelated revocation")
	}
}

func TestExternalIdentityRestoreCannotTransferOwnershipOrReplaceActiveSubject(t *testing.T) {
	f := newBindingFixture(t)
	input := f.bindInput()
	input.Subject = " opaque 😀 "
	bound, err := f.controls.Bind(f.adminCtx, input)
	if err != nil || bound.Subject != input.Subject {
		t.Fatalf("opaque prebinding: %v", err)
	}
	if _, err := f.controls.Unbind(f.adminCtx, f.unbindInput(bound.ID)); err != nil {
		t.Fatal(err)
	}
	other, err := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t)).CreateLocalUser(t.Context(), directory.CreateLocalUserInput{RequestID: "other-owner", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Email: "other@example.com", DisplayName: "Other", Password: "correct horse battery staple", Role: domain.OrganizationRoleMember})
	if err != nil {
		t.Fatal(err)
	}
	input.MembershipID = other.Membership.ID
	input.RestoreRevoked = true
	before := f.snapshot(t)
	if _, err := f.controls.Bind(f.adminCtx, input); errorCode(err) != "external_identity_conflict" || f.snapshot(t) != before {
		t.Fatalf("tombstone transferred ownership: %v", err)
	}
	input.MembershipID = f.user.Membership.ID
	input.Subject = "replacement-subject"
	input.RestoreRevoked = false
	replacement, err := f.controls.Bind(f.adminCtx, input)
	if err != nil || replacement.ID == bound.ID {
		t.Fatalf("new subject after revocation: %v", err)
	}
	before = f.snapshot(t)
	input.Subject = "third-subject"
	if _, err := f.controls.Bind(f.adminCtx, input); errorCode(err) != "external_identity_conflict" || f.snapshot(t) != before {
		t.Fatalf("second active Provider/User binding: %v", err)
	}
	input.Subject = bound.Subject
	input.RestoreRevoked = true
	if _, err := f.controls.Bind(f.adminCtx, input); errorCode(err) != "external_identity_conflict" || f.snapshot(t) != before {
		t.Fatalf("restore displaced active subject: %v", err)
	}
}

func TestExternalIdentityLastMethodIgnoresUnusableAlternatives(t *testing.T) {
	for _, kind := range []string{"disabled", "revoked", "other-organization"} {
		t.Run(kind, func(t *testing.T) {
			f := newBindingFixture(t)
			binding := f.bind(t)
			organizationID, membershipID, admin := f.admin.Organization.ID, f.user.Membership.ID, f.adminCtx
			if kind == "other-organization" {
				other := f.browser.otherOrganization(t)
				organizationID = other.ID
				login := f.browser.login(t, other.Slug, "member@example.com")
				membershipID = login.Principal.MembershipID
				admin = f.browser.caller(t, f.browser.login(t, other.Slug, "admin@example.com"))
			}
			p := f.additionalProvider(t, organizationID, "alternative")
			input := f.bindInput()
			input.ProviderID = p.ID
			input.MembershipID = membershipID
			alternative, err := f.controls.Bind(admin, input)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "disabled":
				_, err = f.pool.Exec(t.Context(), `UPDATE oidc_providers SET enabled=false WHERE id=$1`, p.ID)
			case "revoked":
				_, err = f.controls.Unbind(admin, f.unbindInput(alternative.ID))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID); err != nil {
				t.Fatal(err)
			}
			before := f.snapshot(t)
			if _, err := f.controls.Unbind(f.adminCtx, f.unbindInput(binding.ID)); errorCode(err) != "external_identity_last_method" || f.snapshot(t) != before {
				t.Fatalf("%s counted as usable login: %v", kind, err)
			}
		})
	}
}
