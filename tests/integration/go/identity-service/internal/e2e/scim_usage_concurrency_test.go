package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestSCIMUsageReprovisionLocksUserBeforeToken(t *testing.T) {
	f := newSCIMVersionFixture(t)
	if err := f.service.DeleteUser(t.Context(), f.auth, f.user.Membership.ID, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, f.user.User.ID); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan uint32, 1)
	var once sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR UPDATE") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	command := scim.CreateUserCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
		User: f.user.User, Membership: f.user.Membership}
	command.User.ID = f.newID("user")
	command.Membership.ID, command.Membership.UserID = f.newID("membership"), command.User.ID
	done := make(chan error, 1)
	workers.Go(func() { _, err := store.SCIM().CreateUser(ctx, command); done <- err })
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case err := <-done:
		t.Fatalf("reprovision skipped User lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	probe, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, lockErr := probe.Exec(ctx, `SELECT id FROM scim_tokens WHERE id=$1 FOR UPDATE NOWAIT`, f.auth.TokenID)
	_ = probe.Rollback(context.WithoutCancel(ctx))
	if lockErr != nil {
		t.Fatalf("reprovision holds Token before User, reversing other writes: %v", lockErr)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestSCIMUsageSameTokenWritersDoNotUpgradeLocks(t *testing.T) {
	for _, reprovision := range []bool{false, true} {
		mode := "create"
		if reprovision {
			mode = "reprovision"
		}
		for _, kind := range []string{"user", "group"} {
			t.Run(mode+"/"+kind, func(t *testing.T) {
				f := newBindingFixture(t)
				useNanosecondSCIMUsageClock(f)
				s := pairingService(t, f)
				auth := pairingAuthorization(t, f, s, nil)
				other, err := s.CreateUser(t.Context(), auth, pairedUserInput())
				if err != nil {
					t.Fatal(err)
				}
				group, err := s.CreateGroup(t.Context(), auth, scim.GroupInput{DisplayName: "Other resource", MemberIDs: []string{other.Membership.ID}})
				if err != nil {
					t.Fatal(err)
				}
				input := scim.UserInput{ExternalID: "concurrent-subject", UserName: "concurrent@example.com", Email: "concurrent@example.com", DisplayName: "Concurrent", Active: true}
				if reprovision {
					old, err := s.CreateUser(t.Context(), auth, input)
					if err != nil {
						t.Fatal(err)
					}
					if err := s.DeleteUser(t.Context(), auth, old.Membership.ID, nil); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, auth.TokenID); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				var workers sync.WaitGroup
				defer func() { cancel(); workers.Wait() }()
				release := make(chan struct{})
				firstPID, secondPID := make(chan uint32, 1), make(chan uint32, 1)
				var firstOnce, secondOnce sync.Once
				first := tracedSCIMPairing(t, f, func(ctx context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "UPDATE scim_tokens") && strings.Contains(sql, "last_used_at") {
						firstOnce.Do(func() {
							firstPID <- conn.PgConn().PID()
							select {
							case <-release:
							case <-ctx.Done():
							}
						})
					}
				})
				second := tracedSCIMPairing(t, f, func(_ context.Context, conn *pgx.Conn, sql string) {
					if strings.Contains(sql, "scim_tokens") && (strings.Contains(sql, "FOR UPDATE") || strings.Contains(sql, "UPDATE scim_tokens") && strings.Contains(sql, "last_used_at")) {
						secondOnce.Do(func() { secondPID <- conn.PgConn().PID() })
					}
				})
				firstDone, secondDone := make(chan error, 1), make(chan error, 1)
				workers.Go(func() { _, err := first.CreateUser(ctx, auth, input); firstDone <- err })
				var owner uint32
				select {
				case owner = <-firstPID:
				case err := <-firstDone:
					t.Fatalf("first mutation skipped usage accounting: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Go(func() {
					var err error
					if kind == "user" {
						update := pairedUserInput()
						update.DisplayName = "Updated concurrently"
						_, err = second.ReplaceUser(ctx, auth, other.Membership.ID, scim.ReplaceUserInput{UserInput: update})
					} else {
						_, err = second.ReplaceGroup(ctx, auth, group.Group.ID, scim.ReplaceGroupInput{GroupInput: scim.GroupInput{DisplayName: "Updated concurrently"}})
					}
					secondDone <- err
				})
				var rival uint32
				select {
				case rival = <-secondPID:
				case err := <-secondDone:
					t.Fatalf("second mutation skipped usage accounting: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				finished, secondErr := waitSCIMLineageRival(t, ctx, f.pool, rival, owner, secondDone)
				close(release)
				select {
				case err := <-firstDone:
					if err != nil {
						t.Fatal(err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if !finished {
					select {
					case secondErr = <-secondDone:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
				}
				if secondErr != nil {
					t.Fatalf("concurrent mutation did not commit: %v", secondErr)
				}
				if kind == "user" {
					stored, err := s.GetUser(ctx, auth, other.Membership.ID)
					if err != nil || stored.Membership.DisplayName != "Updated concurrently" {
						t.Fatalf("User replacement not persisted: %v", err)
					}
				} else {
					stored, err := s.GetGroup(ctx, auth, group.Group.ID)
					if err != nil || stored.Group.DisplayName != "Updated concurrently" || len(stored.MemberIDs) != 0 {
						t.Fatalf("Group replacement not persisted: %v", err)
					}
				}
				var usedAt *time.Time
				wantUsedAt := f.clock().Truncate(time.Microsecond)
				if err := f.pool.QueryRow(ctx, `SELECT last_used_at FROM scim_tokens WHERE id=$1`, auth.TokenID).Scan(&usedAt); err != nil || usedAt == nil || !usedAt.Equal(wantUsedAt) {
					t.Fatalf("committed token usage=%v want=%s err=%v", usedAt, wantUsedAt, err)
				}
			})
		}
	}
}
