package e2e

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

// A competing directory operation may finish on the old implementation, or
// wait for the first transaction on the corrected implementation. Observe a
// real database dependency before releasing the blocker; do not make progress
// depend on a sleep or require the serialized operation to finish first.
func waitSCIMLineageRival(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid, owner uint32, done <-chan error) (bool, error) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			return true, err
		default:
		}
		var blockers []uint32
		if err := pool.QueryRow(ctx, `SELECT pg_blocking_pids($1)`, pid).Scan(&blockers); err != nil {
			t.Fatal(err)
		}
		if slices.Contains(blockers, owner) {
			return false, nil
		}
		select {
		case err := <-done:
			return true, err
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func tracedSCIMPairing(t *testing.T, f bindingFixture, before func(context.Context, *pgx.Conn, string)) *scim.Service {
	t.Helper()
	s, err := scim.NewService(scim.Config{Repository: f.tracedStore(t, before).SCIM(), NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSCIMPairingNoLineageCannotBecomeForeignTombstoneDuringProviderWait(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, paired := range []bool{false, true} {
			name := "fresh"
			if existing {
				name = "existing"
			}
			if paired {
				name += "/paired_B"
			} else {
				name += "/NULL"
			}
			t.Run(name, func(t *testing.T) {
				f := newBindingFixture(t)
				s := pairingService(t, f)
				authA := pairingAuthorization(t, f, s, &f.providerID)
				var pairB *string
				if paired {
					provider := f.additionalProvider(t, f.admin.Organization.ID, "lineage-b")
					pairB = &provider.ID
				}
				authB := pairingAuthorization(t, f, s, pairB)
				var userB scim.UserResource
				var err error
				if existing {
					userB, err = s.CreateUser(t.Context(), authB, pairedUserInput())
					if err != nil {
						t.Fatal(err)
					}
				}
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				blocker, err := f.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
				if _, err := blocker.Exec(ctx, `SELECT id FROM oidc_providers WHERE id=$1 FOR UPDATE`, f.providerID); err != nil {
					t.Fatal(err)
				}
				readyA, readyB := make(chan uint32, 1), make(chan uint32, 1)
				var onceA, onceB sync.Once
				a := tracedSCIMPairing(t, f, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
						onceA.Do(func() { readyA <- conn.PgConn().PID() })
					}
				})
				b := tracedSCIMPairing(t, f, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "pg_advisory_xact_lock") || strings.Contains(sql, "FROM organization_memberships") {
						onceB.Do(func() { readyB <- conn.PgConn().PID() })
					}
				})
				doneA, doneB := make(chan error, 1), make(chan error, 1)
				workers.Go(func() { _, err := a.CreateUser(ctx, authA, pairedUserInput()); doneA <- err })
				var pidA uint32
				select {
				case pidA = <-readyA:
					waitForDatabaseLock(t, ctx, f.pool, pidA)
				case err := <-doneA:
					t.Fatalf("first create skipped Provider overlap: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Go(func() {
					if !existing {
						var err error
						userB, err = b.CreateUser(ctx, authB, pairedUserInput())
						if err != nil {
							doneB <- err
							return
						}
					}
					doneB <- b.DeleteUser(ctx, authB, userB.Membership.ID, nil)
				})
				var pidB uint32
				select {
				case pidB = <-readyB:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				finishedB, errB := waitSCIMLineageRival(t, ctx, f.pool, pidB, pidA, doneB)
				if err := blocker.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				var errA error
				select {
				case errA = <-doneA:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if !finishedB {
					select {
					case errB = <-doneB:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				}
				if existing {
					if !errors.Is(errA, domain.ErrConflict) || errB != nil {
						t.Fatalf("create bypassed existing foreign lineage during delete: create=%v delete=%v", errA, errB)
					}
				} else if errA != nil || !errors.Is(errB, domain.ErrConflict) {
					t.Fatalf("two pairings created the same externalId across a tombstone: first=%v rival=%v", errA, errB)
				}
				var users int
				if err := f.pool.QueryRow(ctx, `SELECT count(DISTINCT user_id) FROM organization_memberships WHERE organization_id=$1 AND scim_external_id=$2`, authA.OrganizationID, pairedUserInput().ExternalID).Scan(&users); err != nil || users != 1 {
					t.Fatalf("directory overlap split externalId ownership across %d Users: %v", users, err)
				}
			})
		}
	}
}

func TestSCIMPairingLatestLineageCannotChangeBeforeMembershipInsert(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, nil)
	first, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	binding, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "lineage-prebind", ActorPrincipalID: f.admin.User.ID, MembershipID: first.Membership.ID, ProviderID: f.providerID, Subject: pairedUserInput().ExternalID})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(t.Context(), auth, first.Membership.ID, nil); err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	readyA, readyB, release := make(chan uint32, 1), make(chan uint32, 1), make(chan struct{})
	var onceA, onceB sync.Once
	a := tracedSCIMPairing(t, f, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO organization_memberships") {
			onceA.Do(func() {
				readyA <- conn.PgConn().PID()
				select {
				case <-release:
				case <-ctx.Done():
				}
			})
		}
	})
	b := tracedSCIMPairing(t, f, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "pg_advisory_xact_lock") || strings.Contains(sql, "FROM organization_memberships") {
			onceB.Do(func() { readyB <- conn.PgConn().PID() })
		}
	})
	doneA, doneB := make(chan error, 1), make(chan error, 1)
	workers.Go(func() { _, err := a.CreateUser(ctx, auth, pairedUserInput()); doneA <- err })
	var pidA uint32
	select {
	case pidA = <-readyA:
	case err := <-doneA:
		t.Fatalf("create skipped Membership insertion overlap: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	workers.Go(func() { doneB <- b.DeleteUser(ctx, auth, second.Membership.ID, nil) })
	var pidB uint32
	select {
	case pidB = <-readyB:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	finishedB, errB := waitSCIMLineageRival(t, ctx, f.pool, pidB, pidA, doneB)
	close(release)
	select {
	case err := <-doneA:
		if !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("create used an obsolete deleted Membership after concurrent deletion: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if !finishedB {
		select {
		case errB = <-doneB:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if errB != nil {
		t.Fatal(errB)
	}
	var memberID string
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT membership_id,(SELECT count(*) FROM organization_memberships WHERE user_id=$2) FROM external_identities WHERE id=$1`, binding.ID, first.User.ID).Scan(&memberID, &count); err != nil || memberID != second.Membership.ID || count != 2 {
		t.Fatalf("overlap left a binding attached to an obsolete lineage: member=%s count=%d error=%v", memberID, count, err)
	}
}

func TestSCIMPairingRepeatedReprovisionPreservesLineageAcrossClockRegression(t *testing.T) {
	for _, paired := range []bool{false, true} {
		for _, regression := range []time.Duration{0, -time.Minute} {
			name := "NULL"
			if paired {
				name = "paired"
			}
			t.Run(name+"/"+regression.String(), func(t *testing.T) {
				f := newBindingFixture(t)
				var provider *string
				if paired {
					provider = &f.providerID
				}
				auth := pairingAuthorization(t, f, pairingService(t, f), provider)
				// Public IDs are random, not a creation-order cursor. Choose an
				// earlier ID that sorts after its descendants to expose ties.
				memberIDs := []string{"membership-z-first", "membership-a-second", "membership-b-third"}
				index := 0
				s, err := scim.NewService(scim.Config{Repository: f.store.SCIM(), NewOpaque: credentials.NewOpaqueToken, Now: f.clock, NewID: func(kind string) string {
					if kind != "membership" {
						return f.newID(kind)
					}
					id := memberIDs[index]
					index++
					return id
				}})
				if err != nil {
					t.Fatal(err)
				}
				first, err := s.CreateUser(t.Context(), auth, pairedUserInput())
				if err != nil {
					t.Fatal(err)
				}
				binding, err := f.controls.Bind(f.adminCtx, externalidentities.BindInput{RequestID: "clock-lineage", ActorPrincipalID: f.admin.User.ID, MembershipID: first.Membership.ID, ProviderID: f.providerID, Subject: pairedUserInput().ExternalID})
				if err != nil {
					t.Fatal(err)
				}
				current := first
				for cycle := 0; cycle < 2; cycle++ {
					if err := s.DeleteUser(t.Context(), auth, current.Membership.ID, nil); err != nil {
						t.Fatal(err)
					}
					f.advance(regression)
					next, err := s.CreateUser(t.Context(), auth, pairedUserInput())
					if err != nil || next.User.ID != first.User.ID || next.Membership.ID == current.Membership.ID {
						t.Fatalf("cycle %d lost stable User or chose obsolete lineage: %v", cycle, err)
					}
					current = next
				}
				var actual string
				if err := f.pool.QueryRow(t.Context(), `SELECT membership_id FROM external_identities WHERE id=$1`, binding.ID).Scan(&actual); err != nil || actual != current.Membership.ID {
					t.Fatalf("random ID/clock regression left the binding on %s instead of %s: %v", actual, current.Membership.ID, err)
				}
			})
		}
	}
}

func TestSCIMPairingAmbiguousHistoricalLineageIsRefused(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	auth := pairingAuthorization(t, f, s, nil)
	first, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(t.Context(), auth, first.Membership.ID, nil); err != nil {
		t.Fatal(err)
	}
	// Older versions did not advance creation time beyond the deleted
	// predecessor. Equal historical deletion times cannot identify a generation,
	// even if the rows happen to share User and directory-only authorization.
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO organization_memberships
		(id,organization_id,user_id,email,display_name,role,source,active,scim_external_id,scim_user_name,scim_deleted_at,created_at,updated_at)
		SELECT $2,organization_id,user_id,email,display_name,role,source,active,scim_external_id,scim_user_name,scim_deleted_at,created_at,updated_at
		FROM organization_memberships WHERE id=$1`, first.Membership.ID, f.newID("membership")); err != nil {
		t.Fatal(err)
	}
	before := scimPairingSnapshot(t, f)
	if _, err := s.CreateUser(t.Context(), auth, pairedUserInput()); !errors.Is(err, domain.ErrConflict) || scimPairingSnapshot(t, f) != before {
		t.Fatalf("ambiguous historical lineage was guessed by random ID: %v", err)
	}
}
