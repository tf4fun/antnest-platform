package e2e

import (
	"bytes"
	"context"
	"errors"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type loginPasswordProbe struct {
	credentials.LoginPasswords
	verifications atomic.Int32
	hashes        atomic.Int32
	encoded       atomic.Value
	dummyHash     string
	beforeVerify  func(context.Context) error
	beforeHash    func(context.Context) error
}

func (p *loginPasswordProbe) DummyHash(ctx context.Context) (string, error) {
	encoded, err := p.LoginPasswords.DummyHash(ctx)
	p.dummyHash = encoded
	return encoded, err
}

func (p *loginPasswordProbe) VerifyPassword(ctx context.Context, encoded, password string) (bool, error) {
	p.verifications.Add(1)
	p.encoded.Store(encoded)
	if p.beforeVerify != nil {
		if err := p.beforeVerify(ctx); err != nil {
			return false, err
		}
	}
	return p.LoginPasswords.VerifyPassword(ctx, encoded, password)
}

func (p *loginPasswordProbe) HashPassword(ctx context.Context, password string) (string, error) {
	p.hashes.Add(1)
	if p.beforeHash != nil {
		if err := p.beforeHash(ctx); err != nil {
			return "", err
		}
	}
	return p.LoginPasswords.HashPassword(ctx, password)
}

func localPasswordFixture(t *testing.T) (localAdmissionFixture, *localauth.Service, *loginPasswordProbe) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newLocalAdmissionFixture(t, databaseURL, time.Now)
	passwords := &loginPasswordProbe{LoginPasswords: testPasswordEngine(t)}
	auth, err := localauth.NewService(t.Context(), f.store.LocalAuth(), f.newID, f.clock, time.Hour, passwords)
	if err != nil {
		t.Fatal(err)
	}
	return f, auth, passwords
}

func localPasswordInput(password string) localauth.LoginInput {
	return localauth.LoginInput{RequestID: "persisted-password-attempt", OrganizationSlug: "admission", Email: "member@example.com", Password: password}
}

func TestLocalPasswordLoginCommitsFailuresAndRejectsSixthBeforeKDF(t *testing.T) {
	f, auth, passwords := localPasswordFixture(t)
	for n := 1; n <= 5; n++ {
		result, err := auth.Login(t.Context(), localPasswordInput("incorrect member password"))
		if !errors.Is(err, domain.ErrUnauthenticated) || result.AccessToken != "" {
			t.Fatalf("failure %d was not a confirmed authentication rejection: %v", n, err)
		}
		var rows, minimum, maximum int
		if err := f.pool.QueryRow(t.Context(), `SELECT count(*),COALESCE(min(failures),0),COALESCE(max(failures),0) FROM credential_attempts`).Scan(&rows, &minimum, &maximum); err != nil {
			t.Fatal(err)
		}
		if rows != 2 || minimum != n || maximum != n {
			t.Fatalf("failure %d returned before both counters committed: rows=%d min=%d max=%d", n, rows, minimum, maximum)
		}
	}
	before := localPasswordState(t, f)
	verifications := passwords.verifications.Load()
	result, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	var limited *domain.CredentialRateLimitError
	if !errors.As(err, &limited) || limited.RetryAfterSeconds != 1 || result.AccessToken != "" || passwords.verifications.Load() != verifications {
		t.Fatalf("sixth request bypassed committed backoff: error=%v KDF calls=%d", err, passwords.verifications.Load()-verifications)
	}
	if !bytes.Equal(before, localPasswordState(t, f)) {
		t.Fatal("rate-limited login changed durable state")
	}
	f.assertIssuanceCount(t, 0)
}

func installLegacyLocalPassword(t *testing.T, f localAdmissionFixture) string {
	t.Helper()
	config := credentials.DefaultPasswordConfig()
	config.Policy = credentials.PasswordPolicy{MemoryKiB: 8192, Iterations: 1, Parallelism: 1}
	legacy, err := credentials.NewEngine(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(legacy.Close)
	encoded, err := legacy.HashPassword(t.Context(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1`, f.user.User.ID, encoded); err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestLocalPasswordLoginRehashesAndResetsOnlyAccountWithIssuance(t *testing.T) {
	f, auth, passwords := localPasswordFixture(t)
	existing, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	if err != nil {
		t.Fatal(err)
	}
	oldHash := installLegacyLocalPassword(t, f)
	for range 2 {
		if _, err := auth.Login(t.Context(), localPasswordInput("incorrect member password")); !errors.Is(err, domain.ErrUnauthenticated) {
			t.Fatal(err)
		}
	}
	login, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	if err != nil || login.AccessToken == "" {
		t.Fatalf("legacy login failed: %v", err)
	}
	var stored string
	if err := f.pool.QueryRow(t.Context(), `SELECT password_hash FROM local_credentials WHERE user_id=$1`, f.user.User.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	needs, err := passwords.NeedsRehash(stored)
	if err != nil || needs || stored == oldHash || passwords.hashes.Load() != 1 {
		t.Fatalf("successful legacy login did not persist current policy: needs=%t hashCalls=%d error=%v", needs, passwords.hashes.Load(), err)
	}
	var account, organization int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT failures FROM credential_attempts WHERE scope='login_account'),(SELECT failures FROM credential_attempts WHERE scope='organization')`).Scan(&account, &organization); err != nil || account != 0 || organization != 2 {
		t.Fatalf("successful rehash reset wrong counters: account=%d organization=%d error=%v", account, organization, err)
	}
	if _, err := auth.Resolve(t.Context(), existing.AccessToken); err != nil {
		t.Fatalf("transparent rehash invalidated an existing session: %v", err)
	}
	f.assertIssuanceCount(t, 2)
}

func TestLocalPasswordLoginIssuanceFailureRollsBackRehashAndCounters(t *testing.T) {
	f, auth, passwords := localPasswordFixture(t)
	existing, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	if err != nil {
		t.Fatal(err)
	}
	installLegacyLocalPassword(t, f)
	if _, err := auth.Login(t.Context(), localPasswordInput("incorrect member password")); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `CREATE FUNCTION reject_password_login_token() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected token issuance failure'; END$$;
		CREATE TRIGGER reject_password_login_token BEFORE INSERT ON api_tokens FOR EACH ROW EXECUTE FUNCTION reject_password_login_token()`); err != nil {
		t.Fatal(err)
	}
	before := localPasswordState(t, f)
	login, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
	if err == nil || errors.Is(err, domain.ErrUnauthenticated) || login.AccessToken != "" || passwords.hashes.Load() != 1 {
		t.Fatalf("failed issuance exposed credentials or skipped rehash: hashCalls=%d error=%v", passwords.hashes.Load(), err)
	}
	if !bytes.Equal(before, localPasswordState(t, f)) {
		t.Fatal("failed issuance committed hash, counter reset, token or event")
	}
	if _, err := auth.Resolve(t.Context(), existing.AccessToken); err != nil {
		t.Fatalf("failed issuance affected an existing session: %v", err)
	}
	f.assertIssuanceCount(t, 1)
}

func localPasswordState(t *testing.T, f localAdmissionFixture) []byte {
	t.Helper()
	var snapshot []byte
	if err := f.pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
		'attempts',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY scope,key_hash),'[]'::jsonb) FROM credential_attempts a),
		'credentials',(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM local_credentials c),
		'tokens',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM api_tokens t),
		'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM identity_events e))`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestLocalPasswordLoginUsesOneDummyAndCountsCanonicalDenials(t *testing.T) {
	for _, identity := range []string{"unknown-email", "unknown-organization", "inactive-user", "inactive-membership", "inactive-organization", "missing-credential", "invalid-identity"} {
		t.Run(identity, func(t *testing.T) {
			f, auth, passwords := localPasswordFixture(t)
			input := localPasswordInput("correct horse battery staple")
			var mutation string
			var id string
			switch identity {
			case "unknown-email":
				input.Email = "unknown@example.com"
			case "unknown-organization":
				input.OrganizationSlug = "unknown"
			case "inactive-user":
				mutation, id = `UPDATE users SET active=FALSE WHERE id=$1`, f.user.User.ID
			case "inactive-membership":
				mutation, id = `UPDATE organization_memberships SET active=FALSE WHERE id=$1`, f.user.Membership.ID
			case "inactive-organization":
				mutation, id = `UPDATE organizations SET active=FALSE WHERE id=$1`, f.admin.Organization.ID
			case "missing-credential":
				mutation, id = `DELETE FROM local_credentials WHERE user_id=$1`, f.user.User.ID
			case "invalid-identity":
				input.Email = "not-an-email"
			}
			if mutation != "" {
				if _, err := f.pool.Exec(t.Context(), mutation, id); err != nil {
					t.Fatal(err)
				}
			}
			login, err := auth.Login(t.Context(), input)
			if !errors.Is(err, domain.ErrUnauthenticated) || login.AccessToken != "" || passwords.verifications.Load() != 1 || passwords.encoded.Load() != passwords.dummyHash || passwords.hashes.Load() != 0 {
				t.Fatalf("dummy denial changed verification or issuance: verify=%d hashes=%d error=%v", passwords.verifications.Load(), passwords.hashes.Load(), err)
			}
			var rows, failures int
			if err := f.pool.QueryRow(t.Context(), `SELECT count(*),COALESCE(sum(failures),0) FROM credential_attempts`).Scan(&rows, &failures); err != nil {
				t.Fatal(err)
			}
			want := 2
			if identity == "invalid-identity" {
				want = 0
			}
			if rows != want || failures != want {
				t.Fatalf("dummy denial changed canonical attempt accounting: rows=%d failures=%d", rows, failures)
			}
			f.assertIssuanceCount(t, 0)
		})
	}
}

func TestLocalPasswordLoginErrorsRollbackWithoutCountingOrIssuing(t *testing.T) {
	for _, failure := range []string{"verify-busy", "rehash-busy", "rehash-cancelled", "malformed-hash"} {
		t.Run(failure, func(t *testing.T) {
			f, auth, passwords := localPasswordFixture(t)
			if _, err := auth.Login(t.Context(), localPasswordInput("incorrect member password")); !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatal(err)
			}
			want := error(domain.ErrCredentialBusy)
			switch failure {
			case "verify-busy":
				passwords.beforeVerify = func(context.Context) error { return domain.ErrCredentialBusy }
			case "rehash-busy", "rehash-cancelled":
				installLegacyLocalPassword(t, f)
				if failure == "rehash-cancelled" {
					want = context.Canceled
				}
				passwords.beforeHash = func(ctx context.Context) error {
					if ctx != t.Context() {
						t.Error("rehash received the database wait context instead of the original request")
					}
					return want
				}
			case "malformed-hash":
				want = credentials.ErrInvalidPasswordEncoding
				if _, err := f.pool.Exec(t.Context(), `UPDATE local_credentials SET password_hash='invalid-private-hash' WHERE user_id=$1`, f.user.User.ID); err != nil {
					t.Fatal(err)
				}
			}
			before := localPasswordState(t, f)
			login, err := auth.Login(t.Context(), localPasswordInput("correct horse battery staple"))
			if !errors.Is(err, want) || login.AccessToken != "" || !bytes.Equal(before, localPasswordState(t, f)) {
				t.Fatalf("operation failure became a bad guess or changed durable state: %v", err)
			}
			f.assertIssuanceCount(t, 0)
		})
	}
}
