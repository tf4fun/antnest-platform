package e2e

import (
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func pairingAuthorization(t *testing.T, f bindingFixture, s *scim.Service, provider *string) scim.Authorization {
	t.Helper()
	result, err := s.IssueToken(f.adminCtx, scim.IssueTokenInput{RequestID: "pair-directory", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, OIDCProviderID: provider, Name: "Directory", Scopes: []string{domain.SCIMScopeRead, domain.SCIMScopeWrite}})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := s.Authorize(t.Context(), result.Credential, domain.SCIMScopeWrite)
	if err != nil {
		t.Fatal(err)
	}
	return auth
}

func pairedUserInput() scim.UserInput {
	return scim.UserInput{ExternalID: "subject-1", UserName: "paired@example.com", Email: "paired@example.com", DisplayName: "Paired", Active: true}
}

func TestSCIMPairingCreatesAtomicSignInMethodAndNotice(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, &f.providerID)
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET link_policy='none' WHERE id=$1`, f.providerID); err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	var bindingID, method, subject, memberID, tokenID string
	var notices, events int
	if err := f.pool.QueryRow(t.Context(), `SELECT e.id,e.method,e.subject,e.membership_id,
		(SELECT actor_scim_token_id FROM identity_events WHERE event_type='external_identity.bound' AND subject_id=e.id),
		(SELECT count(*) FROM external_identity_notices WHERE binding_id=e.id AND user_id=e.user_id AND membership_id=e.membership_id AND method='scim'),
		(SELECT count(*) FROM identity_events WHERE event_type='scim_user.created' AND subject_id=e.membership_id)
		FROM external_identities e WHERE e.user_id=$1`, user.User.ID).Scan(&bindingID, &method, &subject, &memberID, &tokenID, &notices, &events); err != nil {
		t.Fatal(err)
	}
	if bindingID == "" || method != "scim" || subject != "subject-1" || memberID != user.Membership.ID || tokenID != auth.TokenID || notices != 1 || events != 1 {
		t.Fatal("binding activation did not commit with SCIM creation and notice")
	}
	stored, err := s.GetUser(t.Context(), auth, user.Membership.ID)
	if err != nil || stored.Membership.SCIMOIDCProviderID == nil || *stored.Membership.SCIMOIDCProviderID != f.providerID {
		t.Fatalf("stored Membership lost pairing: %v", err)
	}
	// IdP's email still names the unrelated local member. Explicit subject
	// binding, under policy none, must select the provisioned User instead.
	login, err := f.flow.CompleteLogin(t.Context(), f.start(t))
	if err != nil || login.Principal.UserID != user.User.ID || login.Principal.MembershipID != user.Membership.ID {
		t.Fatalf("paired subject login selected wrong identity: %v", err)
	}
	before := scimPairingSnapshot(t, f)
	if _, err := s.CreateUser(t.Context(), auth, pairedUserInput()); !errors.Is(err, domain.ErrConflict) || scimPairingSnapshot(t, f) != before {
		t.Fatalf("duplicate created side effects: %v", err)
	}
}

func TestSCIMPairingReprovisionRespectsStoredPairingAndRevokedFacts(t *testing.T) {
	for _, oldPair := range []string{"A", "B", "NULL"} {
		for _, nextPair := range []string{"A", "B", "NULL"} {
			t.Run(oldPair+"_to_"+nextPair, func(t *testing.T) {
				f := newBindingFixture(t)
				s := pairingService(t, f)
				b := f.additionalProvider(t, f.admin.Organization.ID, "second-pairing")
				providers := map[string]*string{"A": &f.providerID, "B": &b.ID, "NULL": nil}
				oldAuth := pairingAuthorization(t, f, s, providers[oldPair])
				nextAuth := pairingAuthorization(t, f, s, providers[nextPair])
				user, err := s.CreateUser(t.Context(), oldAuth, pairedUserInput())
				if err != nil {
					t.Fatal(err)
				}
				bindingProvider := f.providerID
				if providers[oldPair] != nil {
					bindingProvider = *providers[oldPair]
				}
				binding, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "directory-prebind", ActorPrincipalID: f.admin.User.ID, MembershipID: user.Membership.ID, ProviderID: bindingProvider, Subject: "subject-1"})
				if err != nil {
					t.Fatal(err)
				}
				// Reprovision must preserve an explicitly revoked mapping even
				// when using exactly the credential that originally paired it.
				if _, err := f.controls.Unbind(f.adminCtx, externalidentities.UnbindInput{RequestID: "directory-unbind", ActorPrincipalID: f.admin.User.ID, Scope: "organization", MembershipID: user.Membership.ID, BindingID: binding.ID, AllowLockout: true}); err != nil {
					t.Fatal(err)
				}
				var originalNotice string
				if err := f.pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM external_identity_notices n WHERE binding_id=$1`, binding.ID).Scan(&originalNotice); err != nil {
					t.Fatal(err)
				}
				if err := s.DeleteUser(t.Context(), oldAuth, user.Membership.ID, nil); err != nil {
					t.Fatal(err)
				}
				f.advance(time.Second)
				before := scimPairingSnapshot(t, f)
				recreated, err := s.CreateUser(t.Context(), nextAuth, pairedUserInput())
				if oldPair != nextPair {
					if !errors.Is(err, domain.ErrConflict) || scimPairingSnapshot(t, f) != before {
						t.Fatalf("foreign pairing adopted old User: %v", err)
					}
					return
				}
				if err != nil || recreated.User.ID != user.User.ID || recreated.Membership.ID == user.Membership.ID {
					t.Fatalf("same pairing did not preserve User lineage: %v", err)
				}
				var gotMember, gotMethod, notice string
				var boundAt time.Time
				var revokedAt *time.Time
				if err := f.pool.QueryRow(t.Context(), `SELECT membership_id,method,bound_at,revoked_at,(SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM external_identity_notices n WHERE binding_id=$1) FROM external_identities WHERE id=$1`, binding.ID).Scan(&gotMember, &gotMethod, &boundAt, &revokedAt, &notice); err != nil {
					t.Fatal(err)
				}
				if gotMember != recreated.Membership.ID || gotMethod != binding.Method || !boundAt.Equal(binding.BoundAt) || revokedAt == nil || notice != originalNotice {
					t.Fatal("reprovision restored binding or rewrote its activation/notice")
				}
				if oldPair == "A" {
					if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err == nil {
						t.Fatal("reprovision silently restored revoked subject login")
					}
				}
			})
		}
	}
}

func TestSCIMPairingRepointsOnlyTheConfirmedOldMembership(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, nil)
	user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "first-lineage", ActorPrincipalID: f.admin.User.ID, MembershipID: user.Membership.ID, ProviderID: f.providerID, Subject: "subject-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(t.Context(), auth, user.Membership.ID, nil); err != nil {
		t.Fatal(err)
	}
	otherID := f.newID("membership")
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO organization_memberships(id,organization_id,user_id,email,display_name,role,source,active,scim_external_id,scim_user_name,created_at,updated_at)
		SELECT $2,organization_id,user_id,'second-lineage@example.com',display_name,role,source,true,'subject-2','second-lineage@example.com',created_at,updated_at FROM organization_memberships WHERE id=$1`, user.Membership.ID, otherID); err != nil {
		t.Fatal(err)
	}
	b := f.additionalProvider(t, f.admin.Organization.ID, "other-lineage")
	second, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "other-lineage", ActorPrincipalID: f.admin.User.ID, MembershipID: otherID, ProviderID: b.ID, Subject: "subject-2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(t.Context(), auth, otherID, nil); err != nil {
		t.Fatal(err)
	}
	newUser, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	var firstMember, secondMember string
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT membership_id FROM external_identities WHERE id=$1),(SELECT membership_id FROM external_identities WHERE id=$2)`, first.ID, second.ID).Scan(&firstMember, &secondMember); err != nil {
		t.Fatal(err)
	}
	if newUser.User.ID != user.User.ID || firstMember != newUser.Membership.ID || secondMember != otherID {
		t.Fatal("reprovision repointed another historical Membership's binding")
	}
}

func TestSCIMPairingCreateRollsBackBindingNoticeAndAuditFailures(t *testing.T) {
	for _, table := range []string{"external_identity_notices", "identity_events"} {
		t.Run(table, func(t *testing.T) {
			f := newBindingFixture(t)
			s := pairingService(t, f)
			auth := pairingAuthorization(t, f, s, &f.providerID)
			condition := ""
			if table == "identity_events" {
				condition = " WHEN (NEW.event_type='external_identity.bound')"
			}
			if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_scim_pairing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic pairing failure'; END $$;
				CREATE TRIGGER reject_scim_pairing BEFORE INSERT ON `+table+` FOR EACH ROW`+condition+` EXECUTE FUNCTION reject_scim_pairing()`); err != nil {
				t.Fatal(err)
			}
			before := scimPairingSnapshot(t, f)
			if _, err := s.CreateUser(t.Context(), auth, pairedUserInput()); err == nil || scimPairingSnapshot(t, f) != before {
				t.Fatalf("partial pairing effects survived failure: %v", err)
			}
		})
	}
}

func TestSCIMPairingCreateCannotAcquireAnotherSubjectsOwner(t *testing.T) {
	f := newBindingFixture(t)
	f.bind(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, &f.providerID)
	before := scimPairingSnapshot(t, f)
	if _, err := s.CreateUser(t.Context(), auth, pairedUserInput()); !errors.Is(err, domain.ErrConflict) || scimPairingSnapshot(t, f) != before {
		t.Fatalf("paired token stole an existing subject: %v", err)
	}
}

func TestSCIMPairingCreateRevalidatesStoredTokenAuthorization(t *testing.T) {
	for _, change := range []string{"invented_pairing", "unknown_token", "revoked", "missing_paired_token"} {
		t.Run(change, func(t *testing.T) {
			f := newBindingFixture(t)
			s := pairingService(t, f)
			auth := pairingAuthorization(t, f, s, nil)
			switch change {
			case "invented_pairing":
				auth.OIDCProviderID = &f.providerID
			case "unknown_token":
				auth.TokenID = "unknown-scim-token"
			case "revoked":
				if err := s.RevokeToken(f.adminCtx, f.admin.User.ID, auth.TokenID); err != nil {
					t.Fatal(err)
				}
			case "missing_paired_token":
				auth.TokenID = ""
				auth.OIDCProviderID = &f.providerID
			}
			before := scimPairingSnapshot(t, f)
			if _, err := s.CreateUser(t.Context(), auth, pairedUserInput()); err == nil || scimPairingSnapshot(t, f) != before {
				t.Fatalf("untrusted token snapshot created authority: %v", err)
			}
		})
	}
}

func TestSCIMPairingCreateReturnsPersistedResource(t *testing.T) {
	for _, paired := range []bool{false, true} {
		name := "unpaired"
		if paired {
			name = "paired"
		}
		t.Run(name, func(t *testing.T) {
			f := newBindingFixture(t)
			f.now.Store(f.clock().Truncate(time.Microsecond).Add(123 * time.Nanosecond).UnixNano())
			s := pairingService(t, f)
			var providerID *string
			if paired {
				providerID = &f.providerID
			}
			auth := pairingAuthorization(t, f, s, providerID)
			created, err := s.CreateUser(t.Context(), auth, pairedUserInput())
			if err != nil {
				t.Fatal(err)
			}
			stored, err := s.GetUser(t.Context(), auth, created.Membership.ID)
			if err != nil {
				t.Fatal(err)
			}
			for label, timestamps := range map[string][2]time.Time{
				"user created":       {created.User.CreatedAt, stored.User.CreatedAt},
				"user updated":       {created.User.UpdatedAt, stored.User.UpdatedAt},
				"membership created": {created.Membership.CreatedAt, stored.Membership.CreatedAt},
				"membership updated": {created.Membership.UpdatedAt, stored.Membership.UpdatedAt},
			} {
				if !timestamps[0].Equal(timestamps[1]) {
					t.Fatalf("%s response differs from persisted timestamp: %s != %s", label, timestamps[0], timestamps[1])
				}
			}
			command := scim.ReplaceUserCommand{OrganizationID: auth.OrganizationID, ActorTokenID: auth.TokenID, ActorOIDCProviderID: auth.OIDCProviderID, User: created.User, Membership: created.Membership, ExpectedUpdatedAt: created.Membership.UpdatedAt}
			command.Membership.DisplayName = "Replacement"
			command.Membership.UpdatedAt = domain.NextUpdatedAt(f.clock(), created.Membership.UpdatedAt)
			updated, err := f.store.SCIM().ReplaceUser(t.Context(), command)
			if err != nil || updated.Membership.DisplayName != "Replacement" || !updated.Membership.UpdatedAt.After(created.Membership.UpdatedAt) {
				t.Fatalf("create response version could not replace its persisted resource: %v", err)
			}
			before := scimPairingSnapshot(t, f)
			if _, err := f.store.SCIM().ReplaceUser(t.Context(), command); !errors.Is(err, domain.ErrVersionConflict) || scimPairingSnapshot(t, f) != before {
				t.Fatalf("stale create response version was accepted or mutated state: %v", err)
			}
		})
	}
}

func TestSCIMPairingRepositoryProtectsStoredSubjectAndPairing(t *testing.T) {
	for _, change := range []string{"subject", "clear_pairing"} {
		t.Run(change, func(t *testing.T) {
			f := newBindingFixture(t)
			// Exercise PostgreSQL's microsecond precision on every host OS.
			f.now.Store(f.clock().Truncate(time.Microsecond).Add(123 * time.Nanosecond).UnixNano())
			s := pairingService(t, f)
			auth := pairingAuthorization(t, f, s, &f.providerID)
			user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
			if err != nil {
				t.Fatal(err)
			}
			command := scim.ReplaceUserCommand{OrganizationID: auth.OrganizationID, ActorTokenID: auth.TokenID, ActorOIDCProviderID: auth.OIDCProviderID, User: user.User, Membership: user.Membership, ExpectedUpdatedAt: user.Membership.UpdatedAt}
			command.Membership.UpdatedAt = domain.NextUpdatedAt(f.clock(), user.Membership.UpdatedAt)
			if change == "subject" {
				command.Membership.SCIMExternalID = "different"
			} else {
				command.Membership.SCIMOIDCProviderID = nil
			}
			before := scimPairingSnapshot(t, f)
			if _, err := f.store.SCIM().ReplaceUser(t.Context(), command); !errors.Is(err, domain.ErrInvalidArgument) || scimPairingSnapshot(t, f) != before {
				t.Fatalf("repository trusted caller over stored pairing: %v", err)
			}
		})
	}
}

func TestSCIMPairingActiveReprovisionPreservesMethodAndRevokesOldSession(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, &f.providerID)
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET link_policy='none' WHERE id=$1`, f.providerID); err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	oldLogin, err := f.flow.CompleteLogin(t.Context(), f.start(t))
	if err != nil || oldLogin.Principal.UserID != user.User.ID {
		t.Fatalf("initial pairing sign in: %v", err)
	}
	var activation string
	if err := f.pool.QueryRow(t.Context(), `SELECT (to_jsonb(e)-'{membership_id,updated_at}'::text[])::text FROM external_identities e WHERE user_id=$1`, user.User.ID).Scan(&activation); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(t.Context(), auth, user.Membership.ID, nil); err != nil {
		t.Fatal(err)
	}
	f.advance(time.Second)
	recreated, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	if recreated.User.ID != user.User.ID || recreated.Membership.ID == user.Membership.ID {
		t.Fatal("paired reprovision lost exact User lineage")
	}
	var after string
	var oldRevoked *time.Time
	var notices, boundEvents int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT (to_jsonb(e)-'{membership_id,updated_at}'::text[])::text FROM external_identities e WHERE user_id=$1),
		(SELECT revoked_at FROM api_tokens WHERE id=$2),(SELECT count(*) FROM external_identity_notices WHERE user_id=$1),
		(SELECT count(*) FROM identity_events WHERE event_type='external_identity.bound')`, user.User.ID, oldLogin.TokenID).Scan(&after, &oldRevoked, &notices, &boundEvents); err != nil {
		t.Fatal(err)
	}
	if after != activation || oldRevoked == nil || notices != 1 || boundEvents != 1 {
		t.Fatal("reprovision changed activation, duplicated notice, or revived old session")
	}
	login, err := f.flow.CompleteLogin(t.Context(), f.start(t))
	if err != nil || login.Principal.UserID != user.User.ID || login.Principal.MembershipID != recreated.Membership.ID || login.TokenID == oldLogin.TokenID {
		t.Fatalf("reprovisioned sign in did not select new Membership: %v", err)
	}
}

func TestSCIMPairingOtherCredentialsRetainOrganizationDirectoryScope(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	a := pairingAuthorization(t, f, s, &f.providerID)
	other := f.additionalProvider(t, f.admin.Organization.ID, "other-directory-credential")
	credentials := []scim.Authorization{pairingAuthorization(t, f, s, &other.ID), pairingAuthorization(t, f, s, nil)}
	input := pairedUserInput()
	input.ExternalID = " exact paired subject "
	user, err := s.CreateUser(t.Context(), a, input)
	if err != nil {
		t.Fatal(err)
	}
	for _, auth := range credentials {
		input.ExternalID = "" // omission must preserve A's exact stored subject
		input.DisplayName = "Directory edit through another credential"
		updated, err := s.ReplaceUser(t.Context(), auth, user.Membership.ID, scim.ReplaceUserInput{UserInput: input})
		if err != nil || updated.Membership.SCIMExternalID != " exact paired subject " || updated.Membership.SCIMOIDCProviderID == nil || *updated.Membership.SCIMOIDCProviderID != f.providerID {
			t.Fatalf("ordinary directory edit reinterpreted pairing: %v", err)
		}
		page, err := s.ListUsers(t.Context(), auth, scim.ListQuery{Count: 100})
		if err != nil || len(page.Items) != 1 || page.Items[0].Membership.ID != user.Membership.ID {
			t.Fatalf("pairing partitioned directory listing: %v", err)
		}
		group, err := s.CreateGroup(t.Context(), auth, scim.GroupInput{DisplayName: "Directory group", MemberIDs: []string{user.Membership.ID}})
		if err != nil {
			t.Fatal(err)
		}
		if got, err := s.GetGroup(t.Context(), a, group.Group.ID); err != nil || len(got.MemberIDs) != 1 || got.MemberIDs[0] != user.Membership.ID {
			t.Fatalf("pairing partitioned group membership: %v", err)
		}
	}
	var bindings, notices, boundEvents int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM external_identities),(SELECT count(*) FROM external_identity_notices),(SELECT count(*) FROM identity_events WHERE event_type='external_identity.bound')`).Scan(&bindings, &notices, &boundEvents); err != nil {
		t.Fatal(err)
	}
	if bindings != 1 || notices != 1 || boundEvents != 1 {
		t.Fatal("ordinary directory update created a new Provider binding")
	}
}
