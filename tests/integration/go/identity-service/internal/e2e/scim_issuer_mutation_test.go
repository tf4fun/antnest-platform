package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func newSCIMManagedIssuer(t *testing.T, revoke bool) scimIssuerFixture {
	t.Helper()
	f := newSCIMIssuerFixture(t)
	// SCIM creation only grants Member today. Retain coverage for an existing
	// administrator whose Membership is managed by the SCIM directory.
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET source='scim',
		scim_user_name=email,scim_external_id='managed-issuer' WHERE id=$1`, f.members[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.InitializeSCIMTokens(t.Context(), revoke); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f scimIssuerFixture) scimOffboard(ctx context.Context, service *scim.Service, auth scim.Authorization, kind string, condition *scim.IfMatchCondition) error {
	if kind == "delete" {
		return service.DeleteUser(ctx, auth, f.members[0].ID, condition)
	}
	member := f.members[0]
	_, err := service.ReplaceUser(ctx, auth, member.ID, scim.ReplaceUserInput{UserInput: scim.UserInput{
		ExternalID: "managed-issuer", UserName: member.Email, Email: member.Email, DisplayName: member.DisplayName, Active: false,
	}, IfMatch: condition})
	return err
}

func (f scimIssuerFixture) stableSCIMToken(t *testing.T, id string) string {
	t.Helper()
	var value string
	if err := f.pool.QueryRow(t.Context(), `SELECT (to_jsonb(t)-ARRAY['revoked_at','issuer_review_required','last_used_at'])::text FROM scim_tokens t WHERE id=$1`, id).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func (f scimIssuerFixture) scimTokenWithoutUsage(t *testing.T, id string) string {
	t.Helper()
	var value string
	if err := f.pool.QueryRow(t.Context(), `SELECT (to_jsonb(t)-'last_used_at')::text FROM scim_tokens t WHERE id=$1`, id).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestSCIMIssuerManagedOffboardingAppliesPolicyAndPreservesOtherAuthority(t *testing.T) {
	for _, kind := range []string{"replace", "delete"} {
		for _, policy := range []string{"revoke", "review"} {
			for _, actor := range []string{"other", "self"} {
				t.Run(kind+"/"+policy+"/"+actor, func(t *testing.T) {
					f := newSCIMManagedIssuer(t, policy == "revoke")
					extra, err := f.scim.IssueToken(f.issuerCtx, scim.IssueTokenInput{RequestID: "expired-issuer-token", ActorPrincipalID: f.user.User.ID, OrganizationID: f.members[0].OrganizationID, Name: "Expired issuer token", Scopes: []string{domain.SCIMScopeWrite}})
					if err != nil {
						t.Fatal(err)
					}
					if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET created_at=$2,expires_at=$3 WHERE id=$1`, extra.Token.ID, f.clock().Add(-48*time.Hour), f.clock().Add(-time.Hour)); err != nil {
						t.Fatal(err)
					}
					affected := []scim.IssueTokenResult{f.tokens[0], extra}
					credential := f.unrelated.Credential
					if actor == "self" {
						credential = f.tokens[0].Credential
					}
					auth, err := f.scim.Authorize(t.Context(), credential, domain.SCIMScopeWrite)
					if err != nil {
						t.Fatal(err)
					}
					otherOrg := f.tokenRow(t, f.tokens[1].Token.ID, false)
					unrelated := f.scimTokenWithoutUsage(t, f.unrelated.Token.ID)
					stable := []string{f.stableSCIMToken(t, affected[0].Token.ID), f.stableSCIMToken(t, affected[1].Token.ID)}
					eventType := "scim_token.revoked"
					if policy == "review" {
						eventType = "scim_token.issuer_review_required"
					}
					f.advance(time.Second)
					if err := f.scimOffboard(t.Context(), f.scim, auth, kind, nil); err != nil {
						t.Fatal(err)
					}
					for i, token := range affected {
						var revoked *time.Time
						var reviewed bool
						var audits int
						if err := f.pool.QueryRow(t.Context(), `SELECT revoked_at,issuer_review_required,
							(SELECT count(*) FROM identity_events e WHERE e.subject_id=t.id AND e.metadata->>'reason'='issuer_authority_lost'
							AND e.metadata->>'issued_by'=t.issued_by AND e.actor_scim_token_id=$2
							AND e.event_type=$3 AND e.subject_type='scim_token' AND e.organization_id=t.organization_id)
							FROM scim_tokens t WHERE id=$1`, token.Token.ID, auth.TokenID, eventType).Scan(&revoked, &reviewed, &audits); err != nil {
							t.Fatal(err)
						}
						if (revoked != nil) != (policy == "revoke") || reviewed != (policy == "review") || audits != 1 || f.stableSCIMToken(t, token.Token.ID) != stable[i] {
							t.Errorf("offboarding lifecycle id=%d revoked=%v reviewed=%v audits=%d", i, revoked, reviewed, audits)
						}
						if revoked != nil && !revoked.Equal(f.clock().UTC().Truncate(time.Microsecond)) {
							t.Errorf("revocation time=%v", revoked)
						}
					}
					selfAuth, err := f.scim.Authorize(t.Context(), f.tokens[0].Credential, domain.SCIMScopeWrite)
					if policy == "revoke" {
						if !errors.Is(err, domain.ErrUnauthenticated) {
							t.Fatalf("departed issuer credential still authenticates: %v", err)
						}
					} else {
						if err != nil {
							t.Fatal(err)
						}
						if _, err := f.scim.CreateGroup(t.Context(), selfAuth, scim.GroupInput{DisplayName: "Review policy still permits writes"}); err != nil {
							t.Fatalf("review-only policy required lost issuer authority: %v", err)
						}
					}
					beforeRestore := f.tokenRow(t, f.tokens[0].Token.ID, false)
					adminAuth, err := f.scim.Authorize(t.Context(), f.unrelated.Credential, domain.SCIMScopeWrite)
					if err != nil {
						t.Fatal(err)
					}
					input := scim.UserInput{ExternalID: "managed-issuer", UserName: f.members[0].Email, Email: f.members[0].Email, DisplayName: f.members[0].DisplayName, Active: true}
					if kind == "replace" {
						_, err = f.scim.ReplaceUser(t.Context(), adminAuth, f.members[0].ID, scim.ReplaceUserInput{UserInput: input})
					} else {
						var restored scim.UserResource
						restored, err = f.scim.CreateUser(t.Context(), adminAuth, input)
						if err == nil && (restored.User.ID != f.user.User.ID || restored.Membership.ID == f.members[0].ID) {
							t.Fatal("SCIM restore lost User lineage")
						}
					}
					if err != nil {
						t.Fatal(err)
					}
					if f.tokenRow(t, f.tokens[0].Token.ID, false) != beforeRestore || f.tokenRow(t, f.tokens[1].Token.ID, false) != otherOrg || f.scimTokenWithoutUsage(t, f.unrelated.Token.ID) != unrelated {
						t.Fatal("restoration or scoped loss changed independent Token authority")
					}
				})
			}
		}
	}
}

func TestSCIMIssuerManagedOffboardingPreservesSystemAdministrator(t *testing.T) {
	for _, kind := range []string{"replace", "delete"} {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMManagedIssuer(t, true)
			if _, err := f.pool.Exec(t.Context(), `UPDATE users SET system_role='admin' WHERE id=$1`, f.user.User.ID); err != nil {
				t.Fatal(err)
			}
			auth, err := f.scim.Authorize(t.Context(), f.unrelated.Credential, domain.SCIMScopeWrite)
			if err != nil {
				t.Fatal(err)
			}
			before := f.tokenRow(t, f.tokens[0].Token.ID, false)
			if err := f.scimOffboard(t.Context(), f.scim, auth, kind, nil); err != nil {
				t.Fatal(err)
			}
			principal, err := f.store.Directory().GetPrincipal(t.Context(), f.user.User.ID, f.members[0].OrganizationID)
			if err != nil || !principal.CanAdminister(f.members[0].OrganizationID) || f.tokenRow(t, f.tokens[0].Token.ID, false) != before {
				t.Fatalf("SCIM membership loss removed effective SystemAdmin authority: %v", err)
			}
		})
	}
}

func TestSCIMIssuerManagedOffboardingAuditFailureRollsBack(t *testing.T) {
	for _, kind := range []string{"replace", "delete"} {
		for _, policy := range []string{"revoke", "review"} {
			t.Run(kind+"/"+policy, func(t *testing.T) {
				f := newSCIMManagedIssuer(t, policy == "revoke")
				auth, err := f.scim.Authorize(t.Context(), f.tokens[0].Credential, domain.SCIMScopeWrite)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_managed_issuer_audit() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN IF NEW.metadata->>'reason'='issuer_authority_lost' THEN RAISE EXCEPTION 'managed issuer audit rollback'; END IF; RETURN NEW; END $$;
			CREATE TRIGGER reject_managed_issuer_audit BEFORE INSERT ON identity_events FOR EACH ROW EXECUTE FUNCTION reject_managed_issuer_audit()`); err != nil {
					t.Fatal(err)
				}
				state := scimVersionFixture{bindingFixture: f.bindingFixture}
				before := state.versionSnapshot(t)
				err = f.scimOffboard(t.Context(), f.scim, auth, kind, nil)
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "P0001" || pgErr.Message != "managed issuer audit rollback" || state.versionSnapshot(t) != before {
					t.Fatalf("issuer audit failure did not roll back complete SCIM operation: %v", err)
				}
			})
		}
	}
}

func TestSCIMIssuerManagedStaleConditionLeavesTokensUnchanged(t *testing.T) {
	for _, kind := range []string{"replace", "delete"} {
		t.Run(kind, func(t *testing.T) {
			f := newSCIMManagedIssuer(t, true)
			auth, err := f.scim.Authorize(t.Context(), f.tokens[0].Credential, domain.SCIMScopeWrite)
			if err != nil {
				t.Fatal(err)
			}
			state := scimVersionFixture{bindingFixture: f.bindingFixture}
			before := state.versionSnapshot(t)
			if err := f.scimOffboard(t.Context(), f.scim, auth, kind, scimVersionCondition(t, `W/"0"`)); !errors.Is(err, domain.ErrPreconditionFailed) || state.versionSnapshot(t) != before {
				t.Fatalf("stale conditional offboarding changed Token authority: %v", err)
			}
		})
	}
}

func TestSCIMIssuerManagedLocksActorAndAffectedTokensInOrder(t *testing.T) {
	for _, kind := range []string{"replace", "delete"} {
		for _, actorOrder := range []string{"first", "last"} {
			for _, expiry := range []bool{false, true} {
				name := kind + "/actor-" + actorOrder
				if expiry {
					name += "/expiry"
				} else {
					name += "/success"
				}
				t.Run(name, func(t *testing.T) {
					f := newSCIMManagedIssuer(t, true)
					actorID, affectedID := "scimtoken-a-actor", "scimtoken-z-affected"
					if actorOrder == "last" {
						actorID, affectedID = "scimtoken-z-actor", "scimtoken-a-affected"
					}
					if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET id=$2 WHERE id=$1`, f.unrelated.Token.ID, actorID); err != nil {
						t.Fatal(err)
					}
					if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET id=$2 WHERE id=$1`, f.tokens[0].Token.ID, affectedID); err != nil {
						t.Fatal(err)
					}
					auth, err := f.scim.Authorize(t.Context(), f.unrelated.Credential, domain.SCIMScopeWrite)
					if err != nil {
						t.Fatal(err)
					}
					small, large := actorID, affectedID
					if small > large {
						small, large = large, small
					}
					state := scimVersionFixture{bindingFixture: f.bindingFixture}
					before := state.versionSnapshot(t)
					ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
					var workers sync.WaitGroup
					defer func() { cancel(); workers.Wait() }()
					blocker, err := f.pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
					if _, err := blocker.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE`, large); err != nil {
						t.Fatal(err)
					}
					waiting := make(chan uint32, 1)
					var once sync.Once
					service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
						if strings.Contains(sql, "FROM scim_tokens") && strings.Contains(sql, "FOR UPDATE") {
							once.Do(func() { waiting <- conn.PgConn().PID() })
						}
					})
					done := make(chan error, 1)
					var condition *scim.IfMatchCondition
					if expiry {
						// Admission must recheck after the entire union wait, before
						// returning a stale-condition error or writing anything.
						condition = scimVersionCondition(t, `W/"0"`)
					}
					workers.Go(func() { done <- f.scimOffboard(ctx, service, auth, kind, condition) })
					select {
					case pid := <-waiting:
						if finished, err := waitSCIMLineageRival(t, ctx, f.pool, pid, blocker.Conn().PgConn().PID(), done); finished {
							t.Fatalf("offboarding bypassed larger Token: %v", err)
						}
					case err := <-done:
						t.Fatalf("offboarding skipped Token union: %v", err)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					probe, err := f.pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					_, lockErr := probe.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE NOWAIT`, small)
					_ = probe.Rollback(context.WithoutCancel(ctx))
					var pgErr *pgconn.PgError
					if !errors.As(lockErr, &pgErr) || pgErr.Code != "55P03" {
						t.Fatalf("smaller Token not held before larger Token wait: %v", lockErr)
					}
					if expiry {
						f.advance(90 * 24 * time.Hour)
					}
					if err := blocker.Rollback(ctx); err != nil {
						t.Fatal(err)
					}
					select {
					case err := <-done:
						if expiry {
							if !errors.Is(err, domain.ErrUnauthenticated) || state.versionSnapshot(t) != before {
								t.Fatalf("expired acting Token committed after union wait: %v", err)
							}
						} else {
							if err != nil {
								t.Fatal(err)
							}
							var revoked bool
							if err := f.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM scim_tokens WHERE id=$1`, affectedID).Scan(&revoked); err != nil || !revoked {
								t.Fatalf("affected Token was not revoked: %v", err)
							}
						}
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				})
			}
		}
	}
}
