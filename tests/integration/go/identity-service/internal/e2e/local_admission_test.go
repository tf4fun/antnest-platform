package e2e

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

// Mutations that commit before the first authority lock must be read as the
// authoritative credential. Later mutations are covered by the held-verifier
// serialization tests, rather than a synchronous write inside the locked KDF.
func TestLocalLoginReadsMutationsBeforeCredentialLocks(t *testing.T) {
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
			arguments := []any{fixture.user.User.ID}
			if test.name == "password_rotated" {
				hash, err := testPasswordEngine(t).HashPassword(t.Context(), "rotated member password")
				if err != nil {
					t.Fatal(err)
				}
				arguments = append(arguments, hash)
			}
			var calls int
			var mutationErr error
			adapter := fixture.tracedStore(t, func(ctx context.Context, _ *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM users") && strings.Contains(sql, "FOR SHARE") {
					calls++
					if test.mutate != "" {
						_, mutationErr = fixture.pool.Exec(ctx, test.mutate, arguments...)
					}
				}
			})
			auth, err := localauth.NewService(t.Context(), adapter.LocalAuth(), fixture.newID, time.Now, time.Hour, testPasswordEngine(t))
			if err != nil {
				t.Fatal(err)
			}
			result, err := auth.Login(t.Context(), localauth.LoginInput{
				RequestID: "admission-race", OrganizationSlug: "admission",
				Email: "member@example.com", Password: "correct horse battery staple",
			})
			if calls != 1 || mutationErr != nil {
				t.Fatalf("authority lock barrier: calls=%d mutation=%v", calls, mutationErr)
			}
			wantCount := 0
			if test.mutate == "" || test.name == "role_changed" {
				wantCount = 1
				if err != nil || result.AccessToken == "" {
					t.Fatalf("current credential login: %v", err)
				}
				if test.name == "role_changed" && result.Principal.OrganizationRole != domain.OrganizationRoleAdmin {
					t.Fatal("login did not read the committed current role")
				}
				principal, resolveErr := auth.Resolve(t.Context(), result.AccessToken)
				if resolveErr != nil || principal != result.Principal {
					t.Fatalf("issued principal does not resolve: %v", resolveErr)
				}
			} else if !errors.Is(err, domain.ErrUnauthenticated) || result.AccessToken != "" {
				t.Fatalf("stale login issued credential=%t, error=%v", result.AccessToken != "", err)
			}
			fixture.assertIssuanceCount(t, wantCount)
		})
	}
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
	hash, err := testPasswordEngine(t).HashPassword(t.Context(), "correct horse battery staple")
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
	user, err := directory.NewService(store.Directory(), newID, storedNow, testPasswordEngine(t)).CreateLocalUser(t.Context(), directory.CreateLocalUserInput{
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
