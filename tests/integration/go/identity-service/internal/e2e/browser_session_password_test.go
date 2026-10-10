package e2e

import (
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func browserPasswordInput(f browserControlsFixture) browsersessions.PasswordInput {
	return browsersessions.PasswordInput{RequestID: "password-rotation", ActorPrincipalID: f.user.User.ID, UserID: f.user.User.ID, CurrentPassword: "correct horse battery staple", NewPassword: "replacement correct horse battery staple"}
}

func TestBrowserPasswordRotatesAllOrganizationsWithoutExtendingLifetime(t *testing.T) {
	f := newBrowserControlsFixture(t)
	current := f.login(t, "admission", "member@example.com")
	second := f.otherOrganization(t)
	other := f.login(t, second.Slug, "member@example.com")
	ctx := f.caller(t, current)
	f.now.Add(int64(10 * time.Second))
	result, err := f.service.ChangePassword(ctx, browserPasswordInput(f))
	if err != nil || result.Status != "changed" || result.AccessToken == "" || result.AccessToken == current.AccessToken || result.TokenID == current.TokenID || result.TokenID == other.TokenID || result.Principal != current.Principal || !result.ExpiresAt.Equal(current.ExpiresAt) || !result.IdleExpiresAt.Equal(f.clock().Add(30*time.Minute)) || result.ActivityIntervalMS != 30000 {
		t.Fatalf("password rotation did not atomically return fresh bound authority: %v", err)
	}
	for _, raw := range []string{current.AccessToken, other.AccessToken} {
		if _, err := f.auth.Resolve(t.Context(), raw); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Fatalf("prior browser survived password rotation: %v", err)
		}
	}
	if principal, err := f.auth.Resolve(t.Context(), result.AccessToken); err != nil || principal != result.Principal {
		t.Fatalf("replacement session could not resolve: %v", err)
	}
	var publicID, digest, hint string
	var issued, used time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT public_session_id, token_hash, user_agent_hint, issued_at, last_used_at FROM api_tokens WHERE id = $1`, result.TokenID).Scan(&publicID, &digest, &hint, &issued, &used); err != nil {
		t.Fatal(err)
	}
	if publicID == result.TokenID || publicID == current.TokenID || digest != credentials.HashToken(result.AccessToken) || hint != "浏览器 <script>" || !issued.Equal(f.clock()) || !used.Equal(issued) {
		t.Fatal("replacement token metadata or hash-only persistence is invalid")
	}
	page, err := f.service.ListRevocations(t.Context(), browsersessions.RevocationQuery{Limit: 500})
	if err != nil || len(page.Events) != 2 {
		t.Fatalf("password revocation feed: %v", err)
	}
	for _, event := range page.Events {
		if event.Reason != "password_changed" || event.UserID != f.user.User.ID || event.TokenID == result.TokenID {
			t.Fatal("password event scope or reason is invalid")
		}
	}
	if principal := readRevocations(t, f.localAdmissionFixture, 0, 500); len(principal.Events) != 0 {
		t.Fatal("password rotation emitted principal offboarding")
	}
	// Simulate a lost successful response. Even supplying the now-current
	// password cannot turn the original SID/request ID into a recovery token.
	retry := browserPasswordInput(f)
	retry.CurrentPassword = retry.NewPassword
	if replay, err := f.service.ChangePassword(ctx, retry); !errors.Is(err, callercontext.ErrInvalid) || replay.AccessToken != "" {
		t.Fatalf("revoked caller recovered a replacement credential: %v", err)
	}
	login := localauth.LoginInput{RequestID: "recover-login", OrganizationSlug: "admission", Email: "member@example.com", Password: "correct horse battery staple"}
	if _, err := f.auth.Login(t.Context(), login); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal("old password remained valid")
	}
	login.Password = retry.CurrentPassword
	if recovered, err := f.auth.Login(t.Context(), login); err != nil || recovered.AccessToken == "" {
		t.Fatalf("new-password login failed after lost response: %v", err)
	}
}

func TestBrowserPasswordFeedFailureRollsBackCredentialAndEverySession(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	before := revocationStateSnapshot(t, f.localAdmissionFixture)
	var original string
	if err := f.pool.QueryRow(ctx, `SELECT password_hash FROM local_credentials WHERE user_id = $1`, f.user.User.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION reject_session_feed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic feed failure'; END $$; CREATE TRIGGER reject_session_feed BEFORE INSERT ON session_revocations FOR EACH ROW EXECUTE FUNCTION reject_session_feed()`); err != nil {
		t.Fatal(err)
	}
	result, err := f.service.ChangePassword(ctx, browserPasswordInput(f))
	assertRevocationInsertFailure(t, err)
	if result.AccessToken != "" || result.TokenID != "" {
		t.Fatal("failed password transaction returned a credential")
	}
	after := revocationStateSnapshot(t, f.localAdmissionFixture)
	for table, snapshot := range before {
		if after[table] != snapshot {
			t.Fatalf("failed password rotation changed %s", table)
		}
	}
	var actual string
	var sessionEvents int
	if err := f.pool.QueryRow(ctx, `SELECT password_hash, (SELECT count(*) FROM session_revocations) FROM local_credentials WHERE user_id = $1`, f.user.User.ID).Scan(&actual, &sessionEvents); err != nil {
		t.Fatal(err)
	}
	if actual != original || sessionEvents != 0 {
		t.Fatal("failed rotation changed password or published session events")
	}
}

func TestBrowserWrongPasswordPreservesCurrentSession(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	input := browserPasswordInput(f)
	input.CurrentPassword = "wrong"
	if result, err := f.service.ChangePassword(ctx, input); !errors.Is(err, domain.ErrInvalidArgument) || result.AccessToken != "" {
		t.Fatalf("wrong password did not return a business error: %v", err)
	}
	if _, err := f.auth.Resolve(t.Context(), login.AccessToken); err != nil {
		t.Fatal("wrong current password invalidated caller")
	}
	var tokens, revoked, events int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM api_tokens WHERE revoked_at IS NOT NULL), (SELECT count(*) FROM session_revocations)`).Scan(&tokens, &revoked, &events); err != nil {
		t.Fatal(err)
	}
	if tokens != 1 || revoked != 0 || events != 0 {
		t.Fatal("wrong password caused session lifecycle effects")
	}
}
