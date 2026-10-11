package e2e

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func pairingService(t *testing.T, f bindingFixture) *scim.Service {
	t.Helper()
	s, err := scim.NewService(scim.Config{Repository: f.store.SCIM(), NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

const scimPairingSnapshotSQL = `SELECT jsonb_build_object(
		'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),
		'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM organization_memberships m),
		'scim_tokens',(SELECT jsonb_agg(to_jsonb(t)-'last_used_at' ORDER BY id) FROM scim_tokens t),
		'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM groups g),
		'group_memberships',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM group_memberships g),
		'bindings',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM external_identities e),
		'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM external_identity_notices n),
		'tokens',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM api_tokens t),
		'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e),
		'session_feed',(SELECT jsonb_agg(to_jsonb(s) ORDER BY sequence) FROM session_revocations s),
		'principal_feed',(SELECT jsonb_agg(to_jsonb(p) ORDER BY sequence) FROM principal_revocations p))::text`

func scimPairingSnapshot(t *testing.T, f bindingFixture) string {
	t.Helper()
	var state string
	if err := f.pool.QueryRow(t.Context(), scimPairingSnapshotSQL).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestSCIMPairingTokenPersistsExactSameOrganizationAuthority(t *testing.T) {
	f := newBindingFixture(t)
	other := f.browser.otherOrganization(t)
	input := f.providerInput
	input.OrganizationID = other.ID
	foreign, err := f.flow.UpsertProvider(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	// The limited pairing permission belongs to an ordinary organization admin.
	if _, err := f.pool.Exec(t.Context(), `UPDATE users SET system_role='user' WHERE id=$1`, f.admin.User.ID); err != nil {
		t.Fatal(err)
	}
	f.adminCtx = f.browser.caller(t, f.browser.login(t, "admission", "admin@example.com"))
	s := pairingService(t, f)
	base := scim.IssueTokenInput{RequestID: "pair-token", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Name: "Directory", Scopes: []string{domain.SCIMScopeRead, domain.SCIMScopeWrite}}
	for _, tc := range []struct {
		name, provider string
		valid          bool
	}{{"unknown", "missing-provider", false}, {"foreign", foreign.ID, false}, {"empty", "", false}, {"paired", f.providerID, true}} {
		t.Run(tc.name, func(t *testing.T) {
			before := scimPairingSnapshot(t, f)
			input := base
			input.OIDCProviderID = &tc.provider
			result, err := s.IssueToken(f.adminCtx, input)
			if !tc.valid {
				if err == nil || scimPairingSnapshot(t, f) != before {
					t.Fatalf("invalid pairing created authority: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Token.OIDCProviderID == nil || *result.Token.OIDCProviderID != f.providerID {
				t.Fatal("issued metadata lost pairing")
			}
			reopened, err := repository.New(f.pool, f.newID, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			metadata, err := reopened.SCIM().ListTokens(t.Context(), f.admin.Organization.ID)
			if err != nil || len(metadata) != 1 || metadata[0].OIDCProviderID == nil || *metadata[0].OIDCProviderID != f.providerID {
				t.Fatalf("persisted token pairing missing: %+v %v", metadata, err)
			}
			auth, err := reopened.SCIM().ResolveToken(t.Context(), credentials.HashToken(result.Credential), f.clock())
			if err != nil || auth.OIDCProviderID == nil || *auth.OIDCProviderID != f.providerID || auth.OrganizationID != f.admin.Organization.ID {
				t.Fatalf("resolved token pairing missing: %+v %v", auth, err)
			}
		})
	}
	legacy, err := s.IssueToken(f.adminCtx, base)
	if err != nil || legacy.Token.OIDCProviderID != nil {
		t.Fatalf("legacy issue: %+v %v", legacy.Token, err)
	}
	auth, err := s.Authorize(t.Context(), legacy.Credential, domain.SCIMScopeWrite)
	if err != nil || auth.OIDCProviderID != nil {
		t.Fatalf("legacy token acquired pairing: %+v %v", auth, err)
	}
}

func TestSCIMPairingTokenRejectsExpiredOriginalCaller(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	f.advance(2 * time.Hour)
	before := scimPairingSnapshot(t, f)
	_, err := s.IssueToken(f.adminCtx, scim.IssueTokenInput{RequestID: "expired", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, OIDCProviderID: &f.providerID, Name: "Expired", Scopes: []string{domain.SCIMScopeWrite}})
	if err == nil || scimPairingSnapshot(t, f) != before {
		t.Fatalf("expired caller issued paired token: %v", err)
	}
}
