package e2e

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func browserDeadlineFixture(t *testing.T) (localAdmissionFixture, *localauth.Service, localauth.LoginResult, time.Time) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	fixture := newLocalAdmissionFixture(t, databaseURL, clock)
	auth, err := localauth.NewService(t.Context(), fixture.store.LocalAuth(), fixture.newID, clock, time.Hour, testPasswordEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	login, err := auth.Login(t.Context(), localauth.LoginInput{
		RequestID: "browser-session-deadlines", OrganizationSlug: fixture.admin.Organization.Slug,
		Email: "member@example.com", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("login for deadline test: %v", err)
	}
	return fixture, auth, login, now
}

func TestBrowserLoginStoresIndependentPublicReferenceAndInitialDeadlines(t *testing.T) {
	fixture, _, login, now := browserDeadlineFixture(t)
	var publicID, hash, kind string
	var issued, absolute, idle time.Time
	var lastActive *time.Time
	if err := fixture.pool.QueryRow(t.Context(), `
		SELECT public_session_id, token_hash, kind, issued_at, expires_at, idle_expires_at, last_used_at
		FROM api_tokens WHERE id = $1`, login.TokenID,
	).Scan(&publicID, &hash, &kind, &issued, &absolute, &idle, &lastActive); err != nil {
		t.Fatalf("read browser session metadata: %v", err)
	}
	if publicID == "" || publicID == login.TokenID || publicID == login.AccessToken || publicID == hash {
		t.Fatal("public session reference reused a private identifier or credential")
	}
	if hash != credentials.HashToken(login.AccessToken) || kind != "browser" || !issued.Equal(now) ||
		!absolute.Equal(now.Add(time.Hour)) || !idle.Equal(now.Add(30*time.Minute)) ||
		lastActive == nil || !lastActive.Equal(issued) {
		t.Fatal("initial browser session policy or hash-only storage was not applied")
	}
	encoded, err := json.Marshal(login)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		IdleExpiresAt      time.Time `json:"idle_expires_at"`
		ActivityIntervalMS int       `json:"activity_interval_ms"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if !wire.IdleExpiresAt.Equal(idle) || wire.ActivityIntervalMS != 30000 {
		t.Fatal("login response did not project the stored idle policy")
	}
}

func TestBrowserResolutionDoesNotRecordActivity(t *testing.T) {
	fixture, _, login, now := browserDeadlineFixture(t)
	// Exercise a gap beyond the former five-minute telemetry sampling window.
	if _, err := fixture.pool.Exec(t.Context(), `UPDATE api_tokens SET last_used_at = $2 WHERE id = $1`, login.TokenID, now); err != nil {
		t.Fatal(err)
	}
	var originalIdle time.Time
	if err := fixture.pool.QueryRow(t.Context(), `SELECT idle_expires_at FROM api_tokens WHERE id = $1`, login.TokenID).Scan(&originalIdle); err != nil {
		t.Fatal(err)
	}
	assertUnchanged := func(stage string) {
		t.Helper()
		var lastActive, idle time.Time
		if err := fixture.pool.QueryRow(t.Context(), `SELECT last_used_at, idle_expires_at FROM api_tokens WHERE id = $1`, login.TokenID).Scan(&lastActive, &idle); err != nil {
			t.Fatal(err)
		}
		if !lastActive.Equal(now) || !idle.Equal(originalIdle) {
			t.Fatalf("%s changed activity time by %s or idle deadline by %s", stage, lastActive.Sub(now), idle.Sub(originalIdle))
		}
	}
	adapter := fixture.store.LocalAuth()
	if _, err := adapter.ResolveTokenSession(t.Context(), credentials.HashToken(login.AccessToken), now.Add(6*time.Minute)); err != nil {
		t.Fatalf("raw session lookup: %v", err)
	}
	assertUnchanged("raw session lookup")
	if _, err := adapter.ResolveSession(t.Context(), login.TokenID, now.Add(7*time.Minute)); err != nil {
		t.Fatalf("private SID lookup: %v", err)
	}
	assertUnchanged("private SID lookup")
}

func TestBrowserRawAndSIDResolutionEnforceBothExactDeadlines(t *testing.T) {
	fixture, _, login, now := browserDeadlineFixture(t)
	adapter := fixture.store.LocalAuth()
	cases := []struct {
		name     string
		idle     time.Time
		absolute time.Time
		now      time.Time
		allowed  bool
	}{
		{name: "before idle", idle: now.Add(time.Minute), absolute: now.Add(time.Hour), now: now.Add(time.Minute - time.Microsecond), allowed: true},
		{name: "at idle", idle: now.Add(time.Minute), absolute: now.Add(time.Hour), now: now.Add(time.Minute)},
		{name: "after idle", idle: now.Add(time.Minute), absolute: now.Add(time.Hour), now: now.Add(2 * time.Minute)},
		{name: "before absolute", idle: now.Add(time.Hour), absolute: now.Add(time.Minute), now: now.Add(time.Minute - time.Microsecond), allowed: true},
		{name: "at absolute", idle: now.Add(time.Hour), absolute: now.Add(time.Minute), now: now.Add(time.Minute)},
		{name: "after absolute", idle: now.Add(time.Hour), absolute: now.Add(time.Minute), now: now.Add(2 * time.Minute)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := fixture.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at = $2, expires_at = $3 WHERE id = $1`, login.TokenID, test.idle, test.absolute); err != nil {
				t.Fatal(err)
			}
			_, rawErr := adapter.ResolveTokenSession(t.Context(), credentials.HashToken(login.AccessToken), test.now)
			_, sidErr := adapter.ResolveSession(t.Context(), login.TokenID, test.now)
			if test.allowed {
				if rawErr != nil || sidErr != nil {
					t.Fatalf("live authority denied: raw=%v sid=%v", rawErr, sidErr)
				}
			} else if !errors.Is(rawErr, domain.ErrNotFound) || !errors.Is(sidErr, domain.ErrNotFound) {
				t.Fatalf("expired authority accepted: raw=%v sid=%v", rawErr, sidErr)
			}
		})
	}
}
