package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"go.opentelemetry.io/otel/trace"
)

type browserControlsFixture struct {
	localAdmissionFixture
	now       *atomic.Int64
	authority *callercontext.Authority
	auth      *localauth.Service
	service   *browsersessions.Service
}

func newBrowserControlsFixture(t *testing.T) browserControlsFixture {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	now := &atomic.Int64{}
	now.Store(time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC).UnixNano())
	f := newLocalAdmissionFixture(t, databaseURL, func() time.Time { return time.Unix(0, now.Load()).UTC() })
	return browserControlsForFixture(t, f, now)
}

func browserControlsForFixture(t *testing.T, f localAdmissionFixture, now *atomic.Int64) browserControlsFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := callercontext.NewAuthority(callercontext.Config{KID: "browser", PrivateKey: private, Keys: callercontext.Keys{"browser": public}, Repository: f.store.LocalAuth(), Now: f.clock, NewID: func() string { return f.newID("cct") }})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := localauth.NewService(f.store.LocalAuth(), f.newID, f.clock, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return browserControlsFixture{localAdmissionFixture: f, now: now, authority: authority, auth: auth, service: browsersessions.NewService(f.store.BrowserSessions())}
}

func (f browserControlsFixture) login(t *testing.T, slug, email string) localauth.LoginResult {
	t.Helper()
	result, err := f.auth.Login(t.Context(), localauth.LoginInput{RequestID: "browser-controls", OrganizationSlug: slug, Email: email, Password: "correct horse battery staple", UserAgentHint: "浏览器 <script>"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f browserControlsFixture) caller(t *testing.T, login localauth.LoginResult) context.Context {
	t.Helper()
	_, token, err := f.authority.Issue(t.Context(), login.AccessToken, "session", "")
	if err != nil {
		t.Fatal(err)
	}
	caller, err := f.authority.AuthenticateSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return callercontext.WithCaller(t.Context(), caller)
}

func (f browserControlsFixture) otherOrganization(t *testing.T) domain.Organization {
	t.Helper()
	d := directory.NewService(f.store.Directory(), f.newID, f.clock)
	o, err := d.CreateOrganization(t.Context(), directory.CreateOrganizationInput{RequestID: "create-second", ActorPrincipalID: f.admin.User.ID, Slug: "second", Name: "Second", OwnerEmail: "admin@example.com", OwnerDisplayName: "Administrator"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.AddOrganizationMembership(t.Context(), directory.AddOrganizationMembershipInput{RequestID: "join-second", ActorPrincipalID: f.admin.User.ID, OrganizationID: o.ID, UserID: f.user.User.ID, Email: "member@example.com", DisplayName: "Member", Role: domain.OrganizationRoleMember}); err != nil {
		t.Fatal(err)
	}
	return o
}

func TestBrowserActivityChangesOnlyCurrentSessionAndClipsAbsoluteDeadline(t *testing.T) {
	f := newBrowserControlsFixture(t)
	first := f.login(t, "admission", "member@example.com")
	other := f.login(t, "admission", "member@example.com")
	initial := f.clock()
	absolute := initial.Add(20 * time.Second)
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET expires_at = $2, idle_expires_at = $3 WHERE id = $1`, first.TokenID, absolute, initial.Add(15*time.Second)); err != nil {
		t.Fatal(err)
	}
	ctx := f.caller(t, first)
	f.now.Add(int64(10 * time.Second))
	result, err := f.service.Touch(ctx, f.user.User.ID)
	if err != nil || !result.ExpiresAt.Equal(absolute) || !result.IdleExpiresAt.Equal(absolute) || result.ActivityIntervalMS != 30000 {
		t.Fatalf("activity did not clip to original absolute lifetime: %v", err)
	}
	var firstUsed, otherUsed time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT a.last_used_at, b.last_used_at FROM api_tokens a, api_tokens b WHERE a.id = $1 AND b.id = $2`, first.TokenID, other.TokenID).Scan(&firstUsed, &otherUsed); err != nil {
		t.Fatal(err)
	}
	if !firstUsed.Equal(f.clock()) || !otherUsed.Equal(initial) {
		t.Fatal("activity touched another browser or failed to store actual time")
	}
}

func TestBrowserInventoryUsesPublicReferencesAcrossSelfOrganizations(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	second := f.otherOrganization(t)
	other := f.login(t, second.Slug, "member@example.com")
	admin := f.login(t, "admission", "admin@example.com")
	ctx := f.caller(t, current)
	query := browsersessions.ListInput{ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Limit: 1}
	first, err := f.service.List(ctx, query)
	if err != nil || len(first.Sessions) != 1 || first.NextAfterID == "" {
		t.Fatalf("first public inventory page: %v", err)
	}
	query.AfterID = first.NextAfterID
	next, err := f.service.List(ctx, query)
	if err != nil || len(next.Sessions) != 1 || next.NextAfterID != "" || first.Sessions[0].ID >= next.Sessions[0].ID {
		t.Fatalf("exclusive sorted public cursor: %v", err)
	}
	all := append(first.Sessions, next.Sessions...)
	if all[0].Current == all[1].Current || all[0].OrganizationID == all[1].OrganizationID || all[0].UserAgentHint != "浏览器 <script>" {
		t.Fatal("inventory lost cross-organization metadata or signed current SID")
	}
	encoded, err := json.Marshal(all)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{current.TokenID, other.TokenID, current.AccessToken, other.AccessToken, credentials.HashToken(current.AccessToken), credentials.HashToken(other.AccessToken)} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("public inventory exposed credential or private SID")
		}
	}
	adminQuery := browsersessions.ListInput{ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Scope: "organization", Limit: 100}
	page, err := f.service.List(f.caller(t, admin), adminQuery)
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].OrganizationID != f.admin.Organization.ID || page.Sessions[0].Current {
		t.Fatalf("system admin escaped current organization: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at = $2 WHERE id = $1`, other.TokenID, f.clock()); err != nil {
		t.Fatal(err)
	}
	query.AfterID, query.Limit = "", 100
	page, err = f.service.List(ctx, query)
	if err != nil || len(page.Sessions) != 1 || !page.Sessions[0].Current {
		t.Fatalf("expired session remained in inventory: %v", err)
	}
	var used time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT last_used_at FROM api_tokens WHERE id = $1`, current.TokenID).Scan(&used); err != nil || !used.Equal(current.ExpiresAt.Add(-time.Hour)) {
		t.Fatal("inventory recorded activity")
	}
}

func TestBrowserSelfRevocationIsAtomicAndPublishesOnlySessionFeed(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	second := f.otherOrganization(t)
	other := f.login(t, second.Slug, "member@example.com")
	ctx := trace.ContextWithSpanContext(f.caller(t, current), trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled}))
	input := browsersessions.RevokeInput{RequestID: "revoke-others", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Mode: "others"}
	result, err := f.service.Revoke(ctx, input)
	if err != nil || result.RevokedCount != 1 || result.CurrentRevoked {
		t.Fatalf("self others revocation: %v", err)
	}
	if _, err := f.auth.Resolve(t.Context(), other.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("other organization credential still live: %v", err)
	}
	if _, err := f.auth.Resolve(t.Context(), current.AccessToken); err != nil {
		t.Fatal("current credential was revoked by others mode")
	}
	if result, err := f.service.Revoke(ctx, input); err != nil || result.RevokedCount != 0 || result.CurrentRevoked {
		t.Fatalf("authorized repeat changed revocation count: %v", err)
	}
	input.Mode = "all"
	if result, err := f.service.Revoke(ctx, input); err != nil || result.RevokedCount != 1 || !result.CurrentRevoked {
		t.Fatalf("self all failed to include original SID: %v", err)
	}
	if result, err := f.service.Revoke(ctx, input); !errors.Is(err, callercontext.ErrInvalid) || result != (browsersessions.RevokeResult{}) {
		t.Fatalf("old request ID reauthorized revoked caller: %v", err)
	}
	page, err := f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{Limit: 1})
	if err != nil || len(page.Events) != 1 || page.Events[0].TokenID != other.TokenID || page.Events[0].OrganizationID != second.ID || page.Events[0].Reason != "session_revoked" || page.Events[0].TraceParent == "" {
		t.Fatalf("first private session event: %v", err)
	}
	page, err = f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{AfterSequence: page.NextSequence, Limit: 1})
	if err != nil || len(page.Events) != 1 || page.Events[0].TokenID != current.TokenID {
		t.Fatalf("exclusive session feed: %v", err)
	}
	last := page.NextSequence
	page, err = f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{AfterSequence: last, Limit: 1})
	if err != nil || page.Events == nil || len(page.Events) != 0 || page.NextSequence != last {
		t.Fatalf("empty session feed cursor: %v", err)
	}
	if principal := readRevocations(t, f.localAdmissionFixture, 0, 500); len(principal.Events) != 0 {
		t.Fatal("session-only revocation emitted principal offboarding")
	}
}

func TestBrowserRevocationFeedFailureRollsBackEverySession(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, current)
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION reject_session_feed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic feed failure'; END $$; CREATE TRIGGER reject_session_feed BEFORE INSERT ON session_revocations FOR EACH ROW EXECUTE FUNCTION reject_session_feed()`); err != nil {
		t.Fatal(err)
	}
	result, err := f.service.Revoke(ctx, browsersessions.RevokeInput{RequestID: "feed-failure", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, Scope: "self", Mode: "all"})
	assertRevocationInsertFailure(t, err)
	if result != (browsersessions.RevokeResult{}) {
		t.Fatal("failed feed returned successful revocation counts")
	}
	var revoked, events int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations)`).Scan(&revoked, &events); err != nil {
		t.Fatal(err)
	}
	if revoked != 0 || events != 0 {
		t.Fatal("failed session feed left partial revocations")
	}
}

func TestBrowserBlockedActivityCannotReviveExpiredSession(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	expires := f.clock().Add(5 * time.Second)
	if _, err := f.pool.Exec(t.Context(), `UPDATE api_tokens SET idle_expires_at = $2 WHERE id = $1`, login.TokenID, expires); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.caller(t, login), 10*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := blocker.Exec(ctx, `SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE`, login.TokenID); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	var captured sync.Once
	store := f.tracedStore(t, func(_ context.Context, c *pgx.Conn, sql string) {
		if strings.Contains(sql, "api_tokens") && strings.Contains(sql, "FOR UPDATE") {
			captured.Do(func() { pid <- c.PgConn().PID() })
		}
	})
	type outcome struct {
		result browsersessions.Deadlines
		err    error
	}
	finished := make(chan outcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(store.BrowserSessions()).Touch(ctx, f.user.User.ID)
		finished <- outcome{result, err}
	})
	select {
	case p := <-pid:
		waitForDatabaseLock(t, ctx, f.pool, p)
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker.Conn().PgConn().PID(), p).Scan(&blocked); err != nil || !blocked {
			t.Fatalf("touch did not wait for original blocker: %v", err)
		}
	case r := <-finished:
		t.Fatalf("touch bypassed token lock: %v", r.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	f.now.Store(expires.UnixNano())
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	r := <-finished
	if !errors.Is(r.err, callercontext.ErrInvalid) || r.result != (browsersessions.Deadlines{}) {
		t.Fatalf("blocked touch revived expired authority: %v", r.err)
	}
	var idle, used time.Time
	if err := f.pool.QueryRow(ctx, `SELECT idle_expires_at, last_used_at FROM api_tokens WHERE id = $1`, login.TokenID).Scan(&idle, &used); err != nil {
		t.Fatal(err)
	}
	if !idle.Equal(expires) || !used.Equal(expires.Add(-5*time.Second)) {
		t.Fatal("failed touch persisted activity or a new deadline")
	}
}
