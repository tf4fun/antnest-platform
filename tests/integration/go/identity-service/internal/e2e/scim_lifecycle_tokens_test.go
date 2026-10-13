package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestSCIMLifecycleExpiredTokenCannotAuthenticate(t *testing.T) {
	f := newSCIMVersionFixture(t)
	f.advance(90 * 24 * time.Hour)
	if _, err := f.service.Authorize(t.Context(), f.credential, domain.SCIMScopeRead); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("expired token authenticated: %v", err)
	}
}

func TestSCIMLifecycleAuthorizationRechecksExpiryAfterDatabaseWait(t *testing.T) {
	f := newSCIMVersionFixture(t)
	before := f.versionSnapshot(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `LOCK TABLE scim_tokens IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan uint32, 1)
	var once sync.Once
	service := tracedSCIMPairing(t, f.bindingFixture, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM scim_tokens") && strings.Contains(sql, "token_hash") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	type result struct {
		authorization scim.Authorization
		err           error
	}
	done := make(chan result, 1)
	workers.Go(func() {
		authorization, err := service.Authorize(ctx, f.credential, domain.SCIMScopeRead)
		done <- result{authorization, err}
	})
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
		var blockedByOwner bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::int=ANY(pg_blocking_pids($2::int))`, blocker.Conn().PgConn().PID(), pid).Scan(&blockedByOwner); err != nil || !blockedByOwner {
			t.Fatalf("token read did not wait on the actual table-lock owner: %v", err)
		}
	case result := <-done:
		t.Fatalf("authentication bypassed database wait: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	f.advance(90 * 24 * time.Hour)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if !errors.Is(result.err, domain.ErrUnauthenticated) || result.authorization.TokenID != "" {
			t.Errorf("expired token authenticated after a real database wait: %+v / %v", result.authorization, result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if f.versionSnapshot(t) != before {
		t.Fatal("refused authentication wrote usage, resources or audit")
	}
}

func TestSCIMLifecycleIssuancePersistsTTLAndVerifiedGlobalIssuer(t *testing.T) {
	f := newBindingFixture(t)
	s := pairingService(t, f)
	for _, days := range []int{0, 1, 365} {
		input := scim.IssueTokenInput{RequestID: "ttl", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
			Name: "Bounded directory", Scopes: []string{domain.SCIMScopeWrite}, OIDCProviderID: &f.providerID}
		wantDays := days
		if days == 0 {
			wantDays = 90
		} else {
			input.ExpiresInDays = &days
		}
		result, err := s.IssueToken(f.adminCtx, input)
		if err != nil {
			t.Fatal(err)
		}
		created := f.clock().UTC().Truncate(time.Microsecond)
		if result.Token.IssuedBy == nil || *result.Token.IssuedBy != f.admin.User.ID || *result.Token.IssuedBy == f.admin.Membership.ID ||
			result.Token.IssuerReviewRequired || !result.Token.CreatedAt.Equal(created) || !result.Token.ExpiresAt.Equal(created.Add(time.Duration(wantDays)*24*time.Hour)) {
			t.Fatalf("incorrect issued metadata for %d days: %+v", wantDays, result.Token)
		}
		var hash, issuer string
		var expiration time.Time
		if err := f.pool.QueryRow(t.Context(), `SELECT token_hash,issued_by,expires_at FROM scim_tokens WHERE id=$1`, result.Token.ID).Scan(&hash, &issuer, &expiration); err != nil {
			t.Fatal(err)
		}
		if hash != credentials.HashToken(result.Credential) || issuer != *result.Token.IssuedBy || !expiration.Equal(result.Token.ExpiresAt) {
			t.Fatal("returned lifecycle metadata differs from persisted token")
		}
		listed, err := s.ListTokens(f.adminCtx, f.admin.User.ID, f.admin.Organization.ID)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, token := range listed {
			if token.ID == result.Token.ID {
				found = token.IssuedBy != nil && *token.IssuedBy == issuer && !token.IssuerReviewRequired && token.ExpiresAt.Equal(expiration)
			}
		}
		if !found {
			t.Fatal("inventory lost lifecycle metadata")
		}
		for _, offset := range []time.Duration{-time.Microsecond, 0, time.Microsecond} {
			_, err := f.store.SCIM().ResolveToken(t.Context(), hash, expiration.Add(offset))
			if offset < 0 && err != nil || offset >= 0 && !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("expiry boundary offset=%s err=%v", offset, err)
			}
		}
	}
}

func TestSCIMLifecycleRotationOverlapsUntilExplicitRevocation(t *testing.T) {
	f := newSCIMVersionFixture(t)
	var oldRow string
	if err := f.pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM scim_tokens t WHERE id=$1`, f.auth.TokenID).Scan(&oldRow); err != nil {
		t.Fatal(err)
	}
	days := 365
	rotated, err := f.service.IssueToken(f.adminCtx, scim.IssueTokenInput{RequestID: "rotate", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.auth.OrganizationID,
		Name: "Versioned directory", Scopes: f.auth.Scopes, OIDCProviderID: f.auth.OIDCProviderID, ExpiresInDays: &days})
	if err != nil {
		t.Fatal(err)
	}
	var after string
	if err := f.pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM scim_tokens t WHERE id=$1`, f.auth.TokenID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != oldRow || rotated.Token.ID == f.auth.TokenID || rotated.Credential == f.credential ||
		rotated.Token.IssuedBy == nil || *rotated.Token.IssuedBy != f.admin.User.ID || !rotated.Token.ExpiresAt.Equal(f.clock().UTC().Truncate(time.Microsecond).Add(365*24*time.Hour)) {
		t.Fatal("rotation changed original token or did not issue independent lifecycle metadata")
	}
	for _, raw := range []string{f.credential, rotated.Credential} {
		if _, err := f.service.Authorize(t.Context(), raw, domain.SCIMScopeWrite); err != nil {
			t.Fatalf("rotation overlap rejected a credential: %v", err)
		}
	}
	if err := f.service.RevokeToken(f.adminCtx, f.admin.User.ID, f.auth.TokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Authorize(t.Context(), f.credential, domain.SCIMScopeRead); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old credential survived revocation: %v", err)
	}
	if _, err := f.service.Authorize(t.Context(), rotated.Credential, domain.SCIMScopeWrite); err != nil {
		t.Fatalf("revoke old token affected new token: %v", err)
	}
}

func TestSCIMLifecycleIssuanceClockFollowsActualProviderLockWait(t *testing.T) {
	f := newBindingFixture(t)
	ctx, cancel := context.WithTimeout(f.adminCtx, 15*time.Second)
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
	waiting := make(chan uint32, 1)
	var once sync.Once
	store := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
			once.Do(func() { waiting <- conn.PgConn().PID() })
		}
	})
	command := scim.IssueTokenCommand{RequestID: "late-clock", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
		OIDCProviderID: &f.providerID, TokenID: f.newID("scimtoken"), TokenHash: "synthetic-late-token-hash", Name: "Late clock", Scopes: []string{domain.SCIMScopeRead}, ExpiresInDays: 1, CreatedAt: f.clock()}
	type result struct {
		token scim.Token
		err   error
	}
	done := make(chan result, 1)
	workers.Go(func() { token, err := store.SCIM().IssueToken(ctx, command); done <- result{token, err} })
	select {
	case pid := <-waiting:
		waitForDatabaseLock(t, ctx, f.pool, pid)
	case result := <-done:
		t.Fatalf("issuer bypassed Provider lock: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	f.advance(time.Second + 123*time.Nanosecond)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		created := f.clock().UTC().Truncate(time.Microsecond)
		if result.err != nil || !result.token.CreatedAt.Equal(created) || !result.token.ExpiresAt.Equal(created.Add(24*time.Hour)) {
			t.Fatalf("issue reused pre-wait clock: metadata=%+v err=%v", result.token, result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
