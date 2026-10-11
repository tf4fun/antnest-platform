package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

type bindingFixture struct {
	*oidcAdmissionFixture
	browser     browserControlsFixture
	controls    *externalidentities.Service
	providerID  string
	adminCtx    context.Context
	selfCtx     context.Context
	selfTokenID string
}

func newBindingFixture(t *testing.T) bindingFixture {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newOIDCAdmissionFixture(t, databaseURL)
	b := browserControlsForFixture(t, f.localAdmissionFixture, &f.now)
	admin := b.login(t, "admission", "admin@example.com")
	self := b.login(t, "admission", "member@example.com")
	p, err := f.store.OIDC().FindProvider(t.Context(), f.admin.Organization.ID, "workforce")
	if err != nil {
		t.Fatal(err)
	}
	return bindingFixture{oidcAdmissionFixture: f, browser: b, controls: externalidentities.NewService(f.store.ExternalIdentities()), providerID: p.ID, adminCtx: b.caller(t, admin), selfCtx: b.caller(t, self), selfTokenID: self.TokenID}
}

func (f bindingFixture) bindInput() externalidentities.BindInput {
	return externalidentities.BindInput{RequestID: "bind-request", ActorPrincipalID: f.admin.User.ID, MembershipID: f.user.Membership.ID, ProviderID: f.providerID, Subject: "subject-1"}
}
func (f bindingFixture) bind(t *testing.T) externalidentities.Binding {
	t.Helper()
	binding, err := f.controls.Bind(f.adminCtx, f.bindInput())
	if err != nil {
		t.Fatal(err)
	}
	return binding
}
func (f bindingFixture) unbindInput(id string) externalidentities.UnbindInput {
	return externalidentities.UnbindInput{RequestID: "unbind-request", ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: f.user.Membership.ID, BindingID: id}
}

const externalIdentitySnapshotSQL = `SELECT jsonb_build_object(
		'bindings',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM external_identities e),
		'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM external_identity_notices n),
		'tokens',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM api_tokens t),
		'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e),
		'session_feed',(SELECT jsonb_agg(to_jsonb(s) ORDER BY sequence) FROM session_revocations s),
		'principal_feed',(SELECT jsonb_agg(to_jsonb(p) ORDER BY sequence) FROM principal_revocations p)
	)::text`

func (f bindingFixture) snapshot(t *testing.T) string {
	t.Helper()
	var result string
	if err := f.pool.QueryRow(t.Context(), externalIdentitySnapshotSQL).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestExternalIdentityAdminPrebindingAndTombstoneLifecycle(t *testing.T) {
	f := newBindingFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET link_policy='none' WHERE id=$1`, f.providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err == nil {
		t.Fatal("none admitted an unbound subject")
	}
	bound := f.bind(t)
	if bound.Method != "admin" || bound.RevokedAt != nil || bound.Subject != "subject-1" || !bound.CreatedAt.Equal(bound.BoundAt) {
		t.Fatalf("wrong prebinding metadata: %+v", bound)
	}
	before := f.snapshot(t)
	if again, err := f.controls.Bind(f.adminCtx, f.bindInput()); err != nil || again.ID != bound.ID || f.snapshot(t) != before {
		t.Fatalf("active binding retry mutated state: %v", err)
	}
	if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err != nil {
		t.Fatalf("none rejected explicit prebinding: %v", err)
	}
	removed, err := f.controls.Unbind(f.adminCtx, f.unbindInput(bound.ID))
	if err != nil || removed.RevokedCount != 2 || removed.CurrentRevoked {
		t.Fatalf("unbind failed target sessions: %+v %v", removed, err)
	}
	if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err == nil {
		t.Fatal("callback restored a tombstone")
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET link_policy='verified_email' WHERE id=$1`, f.providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err == nil {
		t.Fatal("email fallback restored a tombstone")
	}
	before = f.snapshot(t)
	if result, err := f.controls.Unbind(f.adminCtx, f.unbindInput(bound.ID)); err != nil || result.RevokedCount != 0 || f.snapshot(t) != before {
		t.Fatalf("revoked unbind retry mutated state: %v", err)
	}
	if _, err := f.controls.Bind(f.adminCtx, f.bindInput()); errorCode(err) != "external_identity_restore_required" || f.snapshot(t) != before {
		t.Fatalf("implicit restore: %v", err)
	}
	f.advance(time.Second)
	input := f.bindInput()
	input.RestoreRevoked = true
	restored, err := f.controls.Bind(f.adminCtx, input)
	if err != nil || restored.ID != bound.ID || !restored.CreatedAt.Equal(bound.CreatedAt) || !restored.BoundAt.After(bound.BoundAt) || restored.RevokedAt != nil {
		t.Fatalf("explicit restore metadata: %+v %v", restored, err)
	}
	var boundEvents, notices, principalFeed, sessionFeed int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM identity_events WHERE event_type='external_identity.bound'),(SELECT count(*) FROM external_identity_notices),(SELECT count(*) FROM principal_revocations),(SELECT count(*) FROM session_revocations)`).Scan(&boundEvents, &notices, &principalFeed, &sessionFeed); err != nil {
		t.Fatal(err)
	}
	if boundEvents != 2 || notices != 2 || principalFeed != 0 || sessionFeed != 2 {
		t.Fatalf("transaction effects: bound=%d notices=%d offboarding=%d sessions=%d", boundEvents, notices, principalFeed, sessionFeed)
	}
}

func errorCode(err error) string { code, _, _ := domain.ErrorDetails(err); return code }

func TestExternalIdentityLastMethodAndExactMembershipAuthorization(t *testing.T) {
	f := newBindingFixture(t)
	bound := f.bind(t)
	if _, err := f.pool.Exec(t.Context(), `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	before := f.snapshot(t)
	input := f.unbindInput(bound.ID)
	if _, err := f.controls.Unbind(f.adminCtx, input); errorCode(err) != "external_identity_last_method" || f.snapshot(t) != before {
		t.Fatalf("last method was removed: %v", err)
	}
	input.MembershipID = f.admin.Membership.ID
	input.AllowLockout = true
	if _, err := f.controls.Unbind(f.adminCtx, input); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("M1 path removed M2 binding: %v", err)
	}
	input = f.unbindInput(bound.ID)
	input.Scope = "self"
	input.ActorPrincipalID = f.admin.User.ID
	input.MembershipID = ""
	input.AllowLockout = true
	if _, err := f.controls.Unbind(f.adminCtx, input); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("self removed another User: %v", err)
	}
	input.ActorPrincipalID = f.user.User.ID
	result, err := f.controls.Unbind(f.selfCtx, input)
	if err != nil || !result.CurrentRevoked || result.RevokedCount != 1 {
		t.Fatalf("explicit self lockout failed: %+v %v", result, err)
	}
}

func TestExternalIdentityNoticeSnapshotsAndExactAcknowledgement(t *testing.T) {
	f := newBindingFixture(t)
	bound := f.bind(t)
	query := externalidentities.ListInput{ActorPrincipalID: f.user.User.ID, Scope: "self", Limit: 1}
	before := f.snapshot(t)
	page, err := f.controls.List(f.selfCtx, query)
	if err != nil || len(page.Bindings) != 1 || page.Notices == nil || len(*page.Notices) != 1 || f.snapshot(t) != before {
		t.Fatalf("read touched state or lost notice: %v", err)
	}
	notice := (*page.Notices)[0]
	if notice.BindingID != bound.ID || notice.ID == bound.ID || notice.Subject != bound.Subject || notice.Method != "admin" {
		t.Fatalf("notice snapshot: %+v", notice)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET display_name='Renamed' WHERE id=$1`, f.providerID); err != nil {
		t.Fatal(err)
	}
	page, err = f.controls.List(f.selfCtx, query)
	if err != nil || page.Bindings[0].ProviderDisplayName != "Renamed" || (*page.Notices)[0].ProviderDisplayName != notice.ProviderDisplayName {
		t.Fatalf("notice changed after Provider rename: %v", err)
	}
	ack := externalidentities.AcknowledgeInput{RequestID: "ack-request", ActorPrincipalID: f.user.User.ID, NoticeIDs: []string{notice.ID, "unknown-notice"}}
	before = f.snapshot(t)
	if _, err := f.controls.Acknowledge(f.selfCtx, ack); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("mixed IDs partially acknowledged: %v", err)
	}
	ack.NoticeIDs = []string{notice.ID}
	ack.ActorPrincipalID = f.admin.User.ID
	if _, err := f.controls.Acknowledge(f.adminCtx, ack); !errors.Is(err, domain.ErrNotFound) || f.snapshot(t) != before {
		t.Fatalf("foreign notice acknowledged: %v", err)
	}
	ack.ActorPrincipalID = f.user.User.ID
	for _, want := range []int{1, 0} {
		result, err := f.controls.Acknowledge(f.selfCtx, ack)
		if err != nil || result.AcknowledgedCount != want {
			t.Fatalf("owned acknowledgement: %+v %v", result, err)
		}
	}
	page, err = f.controls.List(f.selfCtx, query)
	if err != nil || page.Notices == nil || len(*page.Notices) != 0 {
		t.Fatalf("acknowledged notice remained pending: %v", err)
	}
	orgPage, err := f.controls.List(f.adminCtx, externalidentities.ListInput{ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: f.user.Membership.ID, Limit: 10})
	encoded, _ := json.Marshal(orgPage)
	var wire map[string]any
	if json.Unmarshal(encoded, &wire) != nil || err != nil || wire["notices"] != nil || orgPage.Notices != nil {
		t.Fatalf("organization inventory exposed notices: %v", err)
	}
}

func TestExternalIdentityNoticeAndRevocationFailuresRollbackAllEffects(t *testing.T) {
	for _, table := range []string{"external_identity_notices", "identity_events", "session_revocations"} {
		t.Run(table, func(t *testing.T) {
			f := newBindingFixture(t)
			var bound externalidentities.Binding
			if table != "external_identity_notices" {
				bound = f.bind(t)
			}
			if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_binding_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected binding effect failure'; END $$; CREATE TRIGGER reject_binding_effect BEFORE INSERT ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_binding_effect()`); err != nil {
				t.Fatal(err)
			}
			before := f.snapshot(t)
			var err error
			if table == "external_identity_notices" {
				_, err = f.controls.Bind(f.adminCtx, f.bindInput())
			} else {
				_, err = f.controls.Unbind(f.adminCtx, f.unbindInput(bound.ID))
			}
			if err == nil || f.snapshot(t) != before {
				t.Fatalf("%s failure committed partial effects: %v", table, err)
			}
		})
	}
}

func TestExternalIdentityPrebindingRejectsSystemAdministrator(t *testing.T) {
	f := newBindingFixture(t)
	input := f.bindInput()
	input.MembershipID = f.admin.Membership.ID
	before := f.snapshot(t)
	if _, err := f.controls.Bind(f.adminCtx, input); !errors.Is(err, domain.ErrForbidden) || f.snapshot(t) != before {
		t.Fatalf("SystemAdmin target accepted: %v", err)
	}
	// A disabled Provider may be prebound but cannot issue an OIDC session.
	if _, err := f.flow.SetProviderEnabled(t.Context(), oidcflow.SetProviderEnabledInput{RequestID: "disable", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Name: "workforce", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	bound := f.bind(t)
	if bound.ProviderEnabled {
		t.Fatal("disabled Provider was enabled by prebinding")
	}
}
