package e2e

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func passwordMutationState(t *testing.T, f browserControlsFixture) map[string]string {
	t.Helper()
	state := revocationStateSnapshot(t, f.localAdmissionFixture)
	state["password_and_attempts"] = string(localPasswordState(t, f.localAdmissionFixture))
	return state
}

func TestBrowserPasswordAttemptsShareUserAcrossOrganizationsAndResetWithRotation(t *testing.T) {
	f := newBrowserControlsFixture(t)
	first := f.login(t, "admission", "member@example.com")
	secondOrganization := f.otherOrganization(t)
	second := f.login(t, secondOrganization.Slug, "member@example.com")
	contexts := []context.Context{f.caller(t, first), f.caller(t, second)}
	passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	service := browsersessions.NewService(f.store.BrowserSessions(), passwords)
	input := browserPasswordInput(f)
	input.CurrentPassword = "incorrect current password"
	for n := 1; n <= 5; n++ {
		result, err := service.ChangePassword(contexts[(n-1)%2], input)
		if !errors.Is(err, domain.ErrInvalidCurrentPassword) || result != (browsersessions.PasswordResult{}) {
			t.Fatalf("wrong password %d did not commit a normal rejection: %v", n, err)
		}
		var users, minimum, maximum, organizations int
		if err := f.pool.QueryRow(t.Context(), `SELECT
			(SELECT count(*) FROM credential_attempts WHERE scope='password_change_user'),
			(SELECT COALESCE(min(failures),0) FROM credential_attempts WHERE scope='password_change_user'),
			(SELECT COALESCE(max(failures),0) FROM credential_attempts WHERE scope='password_change_user'),
			(SELECT COALESCE(sum(failures),0) FROM credential_attempts WHERE scope='organization')`).Scan(&users, &minimum, &maximum, &organizations); err != nil {
			t.Fatal(err)
		}
		if users != 1 || minimum != n || maximum != n || organizations != n {
			t.Fatalf("wrong password %d did not share the User counter across Organizations: users=%d min=%d max=%d organizationFailures=%d", n, users, minimum, maximum, organizations)
		}
	}
	before := passwordMutationState(t, f)
	input.CurrentPassword = browserPasswordInput(f).CurrentPassword
	blocked, err := service.ChangePassword(contexts[1], input)
	var limited *domain.CredentialRateLimitError
	if !errors.As(err, &limited) || limited.RetryAfterSeconds != 1 || blocked != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 5 || passwords.hashes.Load() != 0 {
		t.Fatalf("sixth cross-Organization attempt reached KDF or bypassed backoff: verifies=%d hashes=%d error=%v", passwords.verifications.Load(), passwords.hashes.Load(), err)
	}
	if !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatal("blocked password change mutated durable state")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		var expired bool
		if err := f.pool.QueryRow(ctx, `SELECT locked_until <= clock_timestamp() FROM credential_attempts WHERE scope='password_change_user'`).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	rotated, err := service.ChangePassword(contexts[1], input)
	if err != nil || rotated.AccessToken == "" || rotated.Status != "changed" || passwords.verifications.Load() != 6 || passwords.hashes.Load() != 1 || !rotated.ExpiresAt.Equal(second.ExpiresAt) {
		t.Fatalf("correct password after real backoff did not rotate: %v", err)
	}
	var userFailures, organizationFailures int
	if err := f.pool.QueryRow(t.Context(), `SELECT
		(SELECT failures FROM credential_attempts WHERE scope='password_change_user'),
		(SELECT sum(failures) FROM credential_attempts WHERE scope='organization')`).Scan(&userFailures, &organizationFailures); err != nil || userFailures != 0 || organizationFailures != 5 {
		t.Fatalf("rotation reset the wrong buckets: user=%d organization=%d error=%v", userFailures, organizationFailures, err)
	}
	for _, old := range []string{first.AccessToken, second.AccessToken} {
		if _, err := f.auth.Resolve(t.Context(), old); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Fatal("password rotation retained a prior Organization session")
		}
	}
	if _, err := f.auth.Resolve(t.Context(), rotated.AccessToken); err != nil {
		t.Fatalf("rotated credential is unusable: %v", err)
	}
}

func TestBrowserPasswordAttemptsRevalidateAfterVerificationBeforeHashOrFailure(t *testing.T) {
	for _, correct := range []bool{false, true} {
		name := "wrong-current"
		if correct {
			name = "correct-current"
		}
		t.Run(name, func(t *testing.T) {
			f := newBrowserControlsFixture(t)
			login := f.login(t, "admission", "member@example.com")
			ctx := f.caller(t, login)
			caller, err := callercontext.CallerFromContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: func(actual context.Context) error {
				if actual != ctx {
					t.Error("password verification replaced the original request context")
				}
				f.now.Store(time.Unix(caller.Claims().ExpiresAt+31, 0).UnixNano())
				return nil
			}}
			input := browserPasswordInput(f)
			if !correct {
				input.CurrentPassword = "incorrect current password"
			}
			before := passwordMutationState(t, f)
			result, err := browsersessions.NewService(f.store.BrowserSessions(), passwords).ChangePassword(ctx, input)
			if !errors.Is(err, callercontext.ErrInvalid) || result != (browsersessions.PasswordResult{}) || passwords.verifications.Load() != 1 || passwords.hashes.Load() != 0 {
				t.Fatalf("expired Caller was counted or hashed a replacement: verifies=%d hashes=%d error=%v", passwords.verifications.Load(), passwords.hashes.Load(), err)
			}
			if !reflect.DeepEqual(before, passwordMutationState(t, f)) {
				t.Fatal("Caller expiry after verification changed counters or authority")
			}
		})
	}
}

func TestBrowserPasswordAttemptsFeedFailurePreservesCountersAndAuthority(t *testing.T) {
	f := newBrowserControlsFixture(t)
	login := f.login(t, "admission", "member@example.com")
	ctx := f.caller(t, login)
	input := browserPasswordInput(f)
	input.CurrentPassword = "incorrect current password"
	if _, err := f.service.ChangePassword(ctx, input); !errors.Is(err, domain.ErrInvalidCurrentPassword) {
		t.Fatal(err)
	}
	before := passwordMutationState(t, f)
	if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_attempt_rotation_feed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic feed failure'; END$$;
		CREATE TRIGGER reject_attempt_rotation_feed BEFORE INSERT ON session_revocations FOR EACH ROW EXECUTE FUNCTION reject_attempt_rotation_feed()`); err != nil {
		t.Fatal(err)
	}
	result, err := f.service.ChangePassword(ctx, browserPasswordInput(f))
	assertRevocationInsertFailure(t, err)
	if result != (browsersessions.PasswordResult{}) || !reflect.DeepEqual(before, passwordMutationState(t, f)) {
		t.Fatal("failed rotation committed a counter reset, credential, session or event")
	}
}

func TestBrowserPasswordAttemptsFifthCommitBlocksSixthAcrossOrganizationsAndStores(t *testing.T) {
	f := newBrowserControlsFixture(t)
	first := f.login(t, "admission", "member@example.com")
	// Capture each Organization's bucket from its independent login before
	// password changes run, so an aggregate cannot hide swapped ownership.
	var firstOrganizationKey, otherOrganizationKey []byte
	if err := f.pool.QueryRow(t.Context(), `SELECT key_hash FROM credential_attempts WHERE scope='organization'`).Scan(&firstOrganizationKey); err != nil {
		t.Fatal(err)
	}
	other := f.otherOrganization(t)
	second := f.login(t, other.Slug, "member@example.com")
	if first.Principal.OrganizationID != f.admin.Organization.ID || second.Principal.OrganizationID != other.ID || first.Principal.OrganizationID == second.Principal.OrganizationID {
		t.Fatal("password race requires distinct authenticated Organization bindings")
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT key_hash FROM credential_attempts WHERE scope='organization' AND key_hash<>$1`, firstOrganizationKey).Scan(&otherOrganizationKey); err != nil {
		t.Fatal(err)
	}
	firstCtx, cancel := context.WithTimeout(f.caller(t, first), 15*time.Second)
	secondCtx, cancelSecond := context.WithTimeout(f.caller(t, second), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); cancelSecond(); workers.Wait() }()
	input := browserPasswordInput(f)
	input.CurrentPassword = "incorrect current password"
	for range 4 {
		if _, err := f.service.ChangePassword(firstCtx, input); !errors.Is(err, domain.ErrInvalidCurrentPassword) {
			t.Fatal(err)
		}
	}
	var fifthPID atomic.Uint32
	fifthStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			fifthPID.Store(conn.PgConn().PID())
		}
	})
	entered, release := make(chan struct{}), make(chan struct{})
	fifthPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t), beforeVerify: func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	fifthDone := make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(fifthStore.BrowserSessions(), fifthPasswords).ChangePassword(firstCtx, input)
		fifthDone <- lifecyclePasswordOutcome{result, err}
	})
	select {
	case <-entered:
	case <-firstCtx.Done():
		t.Fatal(firstCtx.Err())
	}
	ready := make(chan uint32, 1)
	var captured sync.Once
	sixthStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "INSERT INTO credential_attempts") {
			captured.Do(func() { ready <- conn.PgConn().PID() })
		}
	})
	sixthPasswords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	sixthDone := make(chan lifecyclePasswordOutcome, 1)
	workers.Go(func() {
		result, err := browsersessions.NewService(sixthStore.BrowserSessions(), sixthPasswords).ChangePassword(secondCtx, browserPasswordInput(f))
		sixthDone <- lifecyclePasswordOutcome{result, err}
	})
	sixthPID := awaitBrowserPID(t, firstCtx, ready)
	assertBrowserBlocker(t, firstCtx, f, sixthPID, fifthPID.Load())
	var waitingSQL string
	if err := f.pool.QueryRow(firstCtx, `SELECT query FROM pg_stat_activity WHERE pid=$1`, sixthPID).Scan(&waitingSQL); err != nil || !strings.Contains(waitingSQL, "INSERT INTO credential_attempts") {
		t.Fatalf("different Organizations did not serialize on the global User bucket before parent locks: %v", err)
	}
	close(release)
	fifth, sixth := <-fifthDone, <-sixthDone
	if !errors.Is(fifth.err, domain.ErrInvalidCurrentPassword) || fifth.result != (browsersessions.PasswordResult{}) || fifthPasswords.verifications.Load() != 1 || fifthPasswords.hashes.Load() != 0 {
		t.Fatalf("fifth attempt did not commit one ordinary rejection: %v", fifth.err)
	}
	if !errors.Is(sixth.err, domain.ErrCredentialRateLimited) || sixth.result != (browsersessions.PasswordResult{}) || sixthPasswords.verifications.Load() != 0 || sixthPasswords.hashes.Load() != 0 {
		t.Fatalf("sixth cross-Organization attempt used stale counters or reached KDF: %v", sixth.err)
	}
	var users, failures, organizations, firstFailures, otherFailures, total int
	if err := f.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM credential_attempts WHERE scope='password_change_user'),
		(SELECT sum(failures) FROM credential_attempts WHERE scope='password_change_user'),
		(SELECT count(*) FROM credential_attempts WHERE scope='organization'),
		(SELECT failures FROM credential_attempts WHERE scope='organization' AND key_hash=$1),
		(SELECT failures FROM credential_attempts WHERE scope='organization' AND key_hash=$2),
		(SELECT sum(failures) FROM credential_attempts WHERE scope='organization')`, firstOrganizationKey, otherOrganizationKey).Scan(&users, &failures, &organizations, &firstFailures, &otherFailures, &total); err != nil {
		t.Fatal(err)
	}
	if users != 1 || failures != 5 || organizations != 2 || firstFailures != 5 || otherFailures != 0 || total != 5 {
		t.Fatalf("cross-Organization fifth/sixth race changed extra counters: users=%d failures=%d organizations=%d first=%d other=%d sum=%d", users, failures, organizations, firstFailures, otherFailures, total)
	}
	for _, raw := range []string{first.AccessToken, second.AccessToken} {
		if _, err := f.auth.Resolve(t.Context(), raw); err != nil {
			t.Fatalf("password attempt race revoked an existing session: %v", err)
		}
	}
}
