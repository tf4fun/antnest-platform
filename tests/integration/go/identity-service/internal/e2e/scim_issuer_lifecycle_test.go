package e2e

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

type scimIssuerFixture struct {
	bindingFixture
	directory *directory.Service
	scim      *scim.Service
	members   []domain.OrganizationMembership
	tokens    []scim.IssueTokenResult
	unrelated scim.IssueTokenResult
	issuerCtx context.Context
}

func newSCIMIssuerFixture(t *testing.T) scimIssuerFixture {
	t.Helper()
	f := newBindingFixture(t)
	dir := directory.NewService(f.store.Directory(), f.newID, f.clock, testPasswordEngine(t))
	member, err := dir.UpdateMembership(f.adminCtx, directory.UpdateMembershipInput{
		RequestID: "promote-issuer", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.user.Membership.OrganizationID,
		MembershipID: f.user.Membership.ID, Email: f.user.Membership.Email, DisplayName: "Issuer", Role: domain.OrganizationRoleAdmin, Active: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	otherOrg, err := dir.CreateOrganization(t.Context(), directory.CreateOrganizationInput{
		RequestID: "issuer-other-org", ActorPrincipalID: f.admin.User.ID, Slug: "issuer-other", Name: "Other directory", OwnerEmail: "admin@example.com", OwnerDisplayName: "Administrator",
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := dir.AddOrganizationMembership(t.Context(), directory.AddOrganizationMembershipInput{
		RequestID: "issuer-other-member", ActorPrincipalID: f.admin.User.ID, OrganizationID: otherOrg.ID,
		UserID: f.user.User.ID, Email: f.user.Membership.Email, DisplayName: "Issuer", Role: domain.OrganizationRoleAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}
	s := pairingService(t, f)
	issuerCtx := f.browser.caller(t, f.browser.login(t, "admission", "member@example.com"))
	otherCtx := f.browser.caller(t, f.browser.login(t, otherOrg.Slug, "member@example.com"))
	result := scimIssuerFixture{bindingFixture: f, directory: dir, scim: s, members: []domain.OrganizationMembership{member, other}, issuerCtx: issuerCtx}
	for i, ctx := range []context.Context{issuerCtx, otherCtx} {
		token, err := s.IssueToken(ctx, scim.IssueTokenInput{RequestID: "issuer-token", ActorPrincipalID: f.user.User.ID,
			OrganizationID: result.members[i].OrganizationID, Name: "Issuer directory", Scopes: []string{domain.SCIMScopeWrite}})
		if err != nil {
			t.Fatal(err)
		}
		result.tokens = append(result.tokens, token)
	}
	result.unrelated, err = s.IssueToken(f.adminCtx, scim.IssueTokenInput{RequestID: "other-issuer", ActorPrincipalID: f.admin.User.ID,
		OrganizationID: member.OrganizationID, Name: "Other issuer directory", Scopes: []string{domain.SCIMScopeWrite}})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f scimIssuerFixture) change(t *testing.T, mode string, restore bool) error {
	t.Helper()
	f.advance(time.Second)
	if mode == "global" {
		return f.directory.SetUserActive(f.adminCtx, directory.SetUserActiveInput{RequestID: "issuer-global", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: restore})
	}
	member := f.members[0]
	role, active := domain.OrganizationRoleAdmin, true
	if !restore && mode == "demote" {
		role = domain.OrganizationRoleMember
	} else if !restore {
		active = false
	}
	_, err := f.directory.UpdateMembership(f.adminCtx, directory.UpdateMembershipInput{RequestID: "issuer-membership", ActorPrincipalID: f.admin.User.ID,
		OrganizationID: member.OrganizationID, MembershipID: member.ID, Email: member.Email, DisplayName: member.DisplayName, Role: role, Active: active})
	return err
}

func (f scimIssuerFixture) tokenRow(t *testing.T, id string, omitLifecycle bool) string {
	t.Helper()
	projection := "to_jsonb(t)"
	if omitLifecycle {
		projection += "-ARRAY['revoked_at','issuer_review_required']"
	}
	var row string
	if err := f.pool.QueryRow(t.Context(), `SELECT (`+projection+`)::text FROM scim_tokens t WHERE id=$1`, id).Scan(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

func (f scimIssuerFixture) tokenSnapshot(t *testing.T) string {
	t.Helper()
	var snapshot string
	if err := f.pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(
		to_jsonb(t) || jsonb_build_object('xmin', t.xmin::text) ORDER BY t.id), '[]'::jsonb)::text
		FROM scim_tokens t`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestSCIMIssuerLossReviewPolicyPersistsWithoutRevokingOrClearingOnRestore(t *testing.T) {
	for _, mode := range []string{"demote", "global"} {
		t.Run(mode, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			if _, err := f.store.InitializeSCIMTokens(t.Context(), false); err != nil {
				t.Fatal(err)
			}
			if err := f.change(t, mode, false); err != nil {
				t.Fatal(err)
			}
			if err := f.change(t, mode, true); err != nil {
				t.Fatal(err)
			}
			for i, token := range f.tokens {
				var review bool
				var revoked *time.Time
				var audits int
				if err := f.pool.QueryRow(t.Context(), `SELECT issuer_review_required,revoked_at,
					(SELECT count(*) FROM identity_events e WHERE e.subject_id=t.id AND e.event_type='scim_token.issuer_review_required')
					FROM scim_tokens t WHERE id=$1`, token.Token.ID).Scan(&review, &revoked, &audits); err != nil {
					t.Fatal(err)
				}
				want := i == 0 || mode == "global"
				wantAudits := 0
				if want {
					wantAudits = 1
				}
				if review != want || revoked != nil || audits != wantAudits {
					t.Errorf("review policy org=%d review=%v revoked=%v audits=%d", i, review, revoked, audits)
				}
				if _, err := f.scim.Authorize(t.Context(), token.Credential, domain.SCIMScopeWrite); err != nil {
					t.Errorf("review-only credential rejected: %v", err)
				}
			}
		})
	}
}

func TestSCIMIssuerLossPreservesEffectiveSystemAdministrator(t *testing.T) {
	for _, mode := range []string{"demote", "deactivate"} {
		t.Run(mode, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			if _, err := f.pool.Exec(t.Context(), `UPDATE users SET system_role='admin' WHERE id=$1`, f.user.User.ID); err != nil {
				t.Fatal(err)
			}
			before := f.tokenRow(t, f.tokens[0].Token.ID, false)
			if err := f.change(t, mode, false); err != nil {
				t.Fatal(err)
			}
			if f.tokenRow(t, f.tokens[0].Token.ID, false) != before {
				t.Fatal("Membership loss revoked an effective SystemAdmin's token")
			}
			if _, err := f.scim.Authorize(t.Context(), f.tokens[0].Credential, domain.SCIMScopeWrite); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSCIMIssuerStartupReconcilesKnownLossAndPreservesUnknownIssuers(t *testing.T) {
	for _, revoke := range []bool{true, false} {
		name := "revoke"
		if !revoke {
			name = "review"
		}
		t.Run(name, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			unknown, err := f.scim.IssueToken(f.adminCtx, scim.IssueTokenInput{RequestID: "legacy", ActorPrincipalID: f.admin.User.ID,
				OrganizationID: f.members[0].OrganizationID, Name: "Unknown issuer", Scopes: []string{domain.SCIMScopeWrite}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET issued_by=NULL,issuer_review_required=TRUE WHERE id=$1`, unknown.Token.ID); err != nil {
				t.Fatal(err)
			}
			// Simulate issuer loss while a pre-lifecycle process was running.
			if _, err := f.pool.Exec(t.Context(), `UPDATE users SET active=FALSE WHERE id=$1`, f.user.User.ID); err != nil {
				t.Fatal(err)
			}
			unknownBefore := f.tokenRow(t, unknown.Token.ID, false)
			unrelatedBefore := f.tokenRow(t, f.unrelated.Token.ID, false)
			summary, err := f.store.InitializeSCIMTokens(t.Context(), revoke)
			if err != nil {
				t.Fatal(err)
			}
			wantRevoked, wantFlagged := 0, 2
			if revoke {
				wantRevoked, wantFlagged = 2, 0
			}
			if summary.Tokens != 4 || summary.UnknownIssuers != 1 || summary.Revoked != wantRevoked || summary.Flagged != wantFlagged {
				t.Errorf("startup summary=%+v", summary)
			}
			for _, token := range f.tokens {
				var reviewed bool
				var revokedAt *time.Time
				if err := f.pool.QueryRow(t.Context(), `SELECT revoked_at,issuer_review_required FROM scim_tokens WHERE id=$1`, token.Token.ID).Scan(&revokedAt, &reviewed); err != nil {
					t.Fatal(err)
				}
				if (revokedAt != nil) != revoke || reviewed != !revoke {
					t.Errorf("startup left lost authority token: revoked=%v review=%v", revokedAt, reviewed)
				}
				_, err := f.scim.Authorize(t.Context(), token.Credential, domain.SCIMScopeWrite)
				if revoke && !errors.Is(err, domain.ErrUnauthenticated) || !revoke && err != nil {
					t.Errorf("startup token authorization=%v", err)
				}
			}
			if f.tokenRow(t, unknown.Token.ID, false) != unknownBefore || f.tokenRow(t, f.unrelated.Token.ID, false) != unrelatedBefore {
				t.Fatal("startup changed unknown issuer or effective administrator")
			}
			if _, err := f.scim.Authorize(t.Context(), unknown.Credential, domain.SCIMScopeWrite); err != nil {
				t.Fatalf("unknown legacy issuer was implicitly revoked: %v", err)
			}
			before := f.snapshot(t)
			tokensBefore := f.tokenSnapshot(t)
			if _, err := f.store.InitializeSCIMTokens(t.Context(), revoke); err != nil || f.snapshot(t) != before || f.tokenSnapshot(t) != tokensBefore {
				t.Fatalf("startup replay changed durable audit or Token row state: %v", err)
			}
		})
	}
}

func TestSCIMIssuerStartupAuditFailureRollsBackWithoutPublishingPolicy(t *testing.T) {
	f := newSCIMIssuerFixture(t)
	// Leave the issuer authoritative in the first Organization so a real
	// offboarding there can expose the Store's policy after failed startup.
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET role='member' WHERE id=$1`, f.members[1].ID); err != nil {
		t.Fatal(err)
	}
	before, tokensBefore := f.snapshot(t), f.tokenSnapshot(t)
	if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_scim_startup_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.event_type='scim_token.issuer_review_required' AND NEW.metadata->>'reason'='issuer_authority_lost'
		THEN RAISE EXCEPTION 'SCIM startup audit rollback marker'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_scim_startup_audit BEFORE INSERT ON identity_events FOR EACH ROW EXECUTE FUNCTION reject_scim_startup_audit()`); err != nil {
		t.Fatal(err)
	}
	summary, err := f.store.InitializeSCIMTokens(t.Context(), false)
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "P0001" || pgError.Message != "SCIM startup audit rollback marker" {
		t.Fatalf("startup bypassed failing issuer review audit: %v", err)
	}
	if summary.Tokens != 0 || summary.Expired != 0 || summary.UnknownIssuers != 0 || summary.Revoked != 0 || summary.Flagged != 0 {
		t.Fatalf("failed startup published an uncommitted summary: %+v", summary)
	}
	if f.snapshot(t) != before || f.tokenSnapshot(t) != tokensBefore {
		t.Fatal("failed startup changed durable state or Token rows")
	}
	if _, err := f.pool.Exec(t.Context(), `DROP TRIGGER reject_scim_startup_audit ON identity_events; DROP FUNCTION reject_scim_startup_audit()`); err != nil {
		t.Fatal(err)
	}
	if err := f.change(t, "demote", false); err != nil {
		t.Fatal(err)
	}
	var revoked *time.Time
	var review bool
	if err := f.pool.QueryRow(t.Context(), `SELECT revoked_at,issuer_review_required FROM scim_tokens WHERE id=$1`, f.tokens[0].Token.ID).Scan(&revoked, &review); err != nil {
		t.Fatal(err)
	}
	if revoked == nil || review {
		t.Fatalf("failed startup changed the default revoke policy: revoked=%v review=%v", revoked, review)
	}
	if summary, err := f.store.InitializeSCIMTokens(t.Context(), false); err != nil || summary.Revoked != 0 || summary.Flagged != 1 {
		t.Fatalf("failed startup pinned an uncommitted policy: summary=%+v err=%v", summary, err)
	}
}

func TestSCIMIssuerLossRevokesOnlyAffectedTokensAndRestoreDoesNotRevive(t *testing.T) {
	for _, mode := range []string{"demote", "deactivate", "global"} {
		t.Run(mode, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			unrelated := f.tokenRow(t, f.unrelated.Token.ID, false)
			before := []string{f.tokenRow(t, f.tokens[0].Token.ID, true), f.tokenRow(t, f.tokens[1].Token.ID, true)}
			if err := f.change(t, mode, false); err != nil {
				t.Fatal(err)
			}
			for _, restore := range []bool{false, true} {
				if restore {
					if err := f.change(t, mode, true); err != nil {
						t.Fatal(err)
					}
				}
				for i, token := range f.tokens {
					wantRevoked := i == 0 || mode == "global"
					var revoked *time.Time
					var review bool
					var audits int
					if err := f.pool.QueryRow(t.Context(), `SELECT revoked_at,issuer_review_required,
						(SELECT count(*) FROM identity_events e WHERE e.subject_id=t.id AND e.event_type='scim_token.revoked' AND e.metadata->>'reason'='issuer_authority_lost')
						FROM scim_tokens t WHERE id=$1`, token.Token.ID).Scan(&revoked, &review, &audits); err != nil {
						t.Fatal(err)
					}
					wantAudits := 0
					if wantRevoked {
						wantAudits = 1
					}
					if (revoked != nil) != wantRevoked || review || audits != wantAudits || f.tokenRow(t, token.Token.ID, true) != before[i] {
						t.Errorf("restore=%v org=%d revoked=%v review=%v audits=%d wantRevoked=%v", restore, i, revoked, review, audits, wantRevoked)
					}
					_, err := f.scim.Authorize(t.Context(), token.Credential, domain.SCIMScopeWrite)
					if wantRevoked && !errors.Is(err, domain.ErrUnauthenticated) || !wantRevoked && err != nil {
						t.Errorf("restore=%v org=%d authorization=%v", restore, i, err)
					}
				}
			}
			if f.tokenRow(t, f.unrelated.Token.ID, false) != unrelated {
				t.Fatal("issuer loss changed another administrator's token")
			}
		})
	}
}

func TestSCIMIssuerLossAuditFailureRollsBackEntireOffboarding(t *testing.T) {
	for _, mode := range []string{"demote", "global"} {
		t.Run(mode, func(t *testing.T) {
			f := newSCIMIssuerFixture(t)
			before := f.snapshot(t)
			rows := []string{f.tokenRow(t, f.tokens[0].Token.ID, false), f.tokenRow(t, f.tokens[1].Token.ID, false)}
			if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_scim_issuer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.event_type='scim_token.revoked' AND NEW.metadata->>'reason'='issuer_authority_lost' THEN RAISE EXCEPTION 'issuer audit rollback marker'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_scim_issuer_audit BEFORE INSERT ON identity_events FOR EACH ROW EXECUTE FUNCTION reject_scim_issuer_audit()`); err != nil {
				t.Fatal(err)
			}
			err := f.change(t, mode, false)
			var pgError *pgconn.PgError
			if !errors.As(err, &pgError) || pgError.Code != "P0001" || pgError.Message != "issuer audit rollback marker" {
				t.Fatalf("offboarding bypassed failing issuer audit: %v", err)
			}
			member, err := f.store.Directory().GetMembership(t.Context(), f.members[0].OrganizationID, f.members[0].ID)
			if err != nil || !member.Active || member.Role != domain.OrganizationRoleAdmin {
				t.Fatalf("failed audit changed membership: %+v %v", member, err)
			}
			principal, err := f.store.Directory().GetPrincipal(t.Context(), f.user.User.ID, "")
			if err != nil || !principal.Active || f.snapshot(t) != before {
				t.Fatalf("failed audit changed user/session/feed state: %+v %v", principal, err)
			}
			for i, token := range f.tokens {
				if f.tokenRow(t, token.Token.ID, false) != rows[i] {
					t.Fatal("failed audit partially changed issuer token")
				}
			}
		})
	}
}
