package e2e

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

// The hook deterministically commits a competing mutation after password
// verification, before the real PostgreSQL adapter can issue the credential.
func TestLocalLoginRevalidatesBeforeIssuingToken(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	cases := []struct {
		name   string
		mutate string
	}{
		{name: "unchanged"},
		{name: "password_rotated", mutate: `UPDATE local_credentials SET password_hash = $2 WHERE user_id = $1`},
		{name: "credential_removed", mutate: `DELETE FROM local_credentials WHERE user_id = $1`},
		{name: "user_disabled", mutate: `UPDATE users SET active = FALSE WHERE id = $1`},
		{name: "membership_disabled", mutate: `UPDATE organization_memberships SET active = FALSE WHERE user_id = $1`},
		{name: "role_changed", mutate: `UPDATE organization_memberships SET role = 'admin' WHERE user_id = $1`},
		{name: "organization_disabled", mutate: `UPDATE organizations SET active = FALSE WHERE id IN (SELECT organization_id FROM organization_memberships WHERE user_id = $1)`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLocalAdmissionFixture(t, databaseURL, time.Now)
			adapter := &beforeIssuanceRepository{Repository: fixture.store.LocalAuth(), before: func() {
				if test.mutate != "" {
					arguments := []any{fixture.user.User.ID}
					if test.name == "password_rotated" {
						hash, err := credentials.HashPassword("rotated member password")
						if err != nil {
							t.Fatal(err)
						}
						arguments = append(arguments, hash)
					}
					if _, err := fixture.pool.Exec(t.Context(), test.mutate, arguments...); err != nil {
						t.Fatalf("commit competing mutation: %v", err)
					}
				}
			}}
			auth, err := localauth.NewService(adapter, fixture.newID, time.Now, time.Hour)
			if err != nil {
				t.Fatal(err)
			}
			result, err := auth.Login(t.Context(), localauth.LoginInput{
				RequestID: "admission-race", OrganizationSlug: "admission",
				Email: "member@example.com", Password: "correct horse battery staple",
			})
			if adapter.calls != 1 {
				t.Fatalf("issuance attempts = %d, want exactly one", adapter.calls)
			}
			wantCount := 0
			if test.mutate == "" {
				wantCount = 1
				if err != nil || result.AccessToken == "" {
					t.Fatalf("unchanged login: %v", err)
				}
				principal, resolveErr := auth.Resolve(t.Context(), result.AccessToken)
				if resolveErr != nil || principal != result.Principal {
					t.Fatalf("issued principal does not resolve: %v", resolveErr)
				}
			} else if !errors.Is(err, domain.ErrUnauthenticated) || result.AccessToken != "" {
				t.Fatalf("stale login issued credential=%t, error=%v; want unauthenticated", result.AccessToken != "", err)
			}
			fixture.assertIssuanceCount(t, wantCount)
		})
	}
}

type beforeIssuanceRepository struct {
	localauth.Repository
	before func()
	calls  int
}

func (r *beforeIssuanceRepository) IssueToken(ctx context.Context, command localauth.IssueTokenCommand) (localauth.Token, error) {
	r.calls++
	r.before()
	return r.Repository.IssueToken(ctx, command)
}

type localAdmissionFixture struct {
	pool  *pgxpool.Pool
	store *repository.Store
	user  directory.CreateLocalUserResult
	newID func(kind string) string
	admin repository.BootstrapResult
	clock func() time.Time
}

// storedNow matches PostgreSQL's microsecond timestamps. Repository writes
// return their input, so a fixture version later used as an expected
// UpdatedAt must already have stored precision; Linux clocks carry
// nanoseconds that the database would truncate.
func storedNow() time.Time {
	return time.Now().UTC().Truncate(time.Microsecond)
}

func newLocalAdmissionFixture(t *testing.T, databaseURL string, clock func() time.Time) localAdmissionFixture {
	t.Helper()
	pool := newIsolatedPool(t, databaseURL)
	if err := repository.ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	var sequence atomic.Uint64
	newID := func(kind string) string { return fmt.Sprintf("admission-%d", sequence.Add(1)) }
	store, err := repository.New(pool, newID, clock)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := store.Bootstrap(t.Context(), repository.BootstrapInput{
		OrganizationSlug: "admission", OrganizationName: "Admission",
		AdminEmail: "admin@example.com", AdminDisplayName: "Administrator",
		PasswordHash: hash, Now: storedNow(),
	})
	if err != nil {
		t.Fatal(err)
	}
	user, err := directory.NewService(store.Directory(), newID, storedNow).CreateLocalUser(t.Context(), directory.CreateLocalUserInput{
		RequestID: "create-member", ActorPrincipalID: bootstrap.User.ID, OrganizationID: bootstrap.Organization.ID,
		Email: "member@example.com", DisplayName: "Member", Password: "correct horse battery staple", Role: domain.OrganizationRoleMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	return localAdmissionFixture{pool: pool, store: store, user: user, newID: newID, admin: bootstrap, clock: clock}
}

func (f localAdmissionFixture) assertIssuanceCount(t *testing.T, want int) {
	t.Helper()
	var tokens, events int
	if err := f.pool.QueryRow(t.Context(), `
		SELECT (SELECT count(*) FROM api_tokens),
		       (SELECT count(*) FROM identity_events WHERE event_type = 'access_token.issued')`).Scan(&tokens, &events); err != nil {
		t.Fatal(err)
	}
	if tokens != want || events != want {
		t.Fatalf("committed tokens=%d events=%d, want %d each", tokens, events, want)
	}
}
