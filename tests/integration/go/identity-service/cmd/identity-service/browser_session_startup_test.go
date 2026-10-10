package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

type browserStartupFixture struct {
	pool                         *pgxpool.Pool
	databaseURL, applicationName string
	bootstrap                    repository.BootstrapResult
}

func newBrowserStartupFixture(t *testing.T) browserStartupFixture {
	t.Helper()
	raw := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	admin, err := pgxpool.New(t.Context(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	schema := "browser_startup_" + fmt.Sprint(time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(t.Context(), "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Errorf("remove startup schema: %v", err)
		}
	})
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("application_name", schema)
	parsed.RawQuery = query.Encode()
	pool, err := pgxpool.New(t.Context(), parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := repository.ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	store, err := repository.New(pool, identityid.MustNew, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := credentials.HashPassword("browser startup test password")
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := store.Bootstrap(t.Context(), repository.BootstrapInput{
		OrganizationSlug: "startup", OrganizationName: "Startup", AdminEmail: "startup@example.test",
		AdminDisplayName: "Startup", PasswordHash: hash, Now: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return browserStartupFixture{pool: pool, databaseURL: parsed.String(), applicationName: schema, bootstrap: bootstrap}
}

func (f browserStartupFixture) seedOldSession(t *testing.T) time.Time {
	t.Helper()
	activity := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Second)
	if _, err := f.pool.Exec(t.Context(), `
		INSERT INTO api_tokens (id, public_session_id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at, idle_expires_at, last_used_at)
		VALUES ('old-token', 'old-public-session', 'old-token-hash', $1, $2, $3, $4, $5, $6, $7)`,
		f.bootstrap.User.ID, f.bootstrap.Organization.ID, f.bootstrap.Membership.ID,
		activity.Add(-time.Minute), activity.Add(time.Hour), activity.Add(30*time.Minute), activity); err != nil {
		t.Fatal(err)
	}
	return activity
}

func browserStartupEnvironment(t *testing.T, fixture browserStartupFixture, address string) (serviceauth.LookupEnv, string) {
	t.Helper()
	t.Setenv("OTEL_SDK_DISABLED", "true")
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "false")
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := json.Marshal(protocol.PublicKeys{Keys: []protocol.PublicKey{{KID: "startup", Kty: "OKP", Crv: "Ed25519", Use: "sig", Alg: "EdDSA", X: base64.RawURLEncoding.EncodeToString(public)}}})
	if err != nil {
		t.Fatal(err)
	}
	tokenBytes, encryptionKey := make([]byte, 32), make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(encryptionKey); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	callers, err := json.Marshal(map[string][]string{"edge-gateway": {fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(token)))}})
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	for name, value := range map[string][]byte{"signing.pem": pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), "jwks.json": keys, "callers.json": callers} {
		if err := os.WriteFile(filepath.Join(directory, name), value, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// No bootstrap variables: session policy initialization must be unconditional.
	environment := map[string]string{
		"ANTNEST_IDENTITY_DATABASE_URL":                 fixture.databaseURL,
		"ANTNEST_IDENTITY_LISTEN":                       address,
		"ANTNEST_IDENTITY_PUBLIC_BASE_URL":              "http://" + address,
		"ANTNEST_IDENTITY_SESSION_IDLE_TTL":             "5s",
		"ANTNEST_IDENTITY_SHUTDOWN_TIMEOUT":             "1s",
		"ANTNEST_IDENTITY_ENCRYPTION_KEY":               base64.StdEncoding.EncodeToString(encryptionKey),
		"ANTNEST_SERVICE_AUTH_MODE":                     "token",
		"ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE":             filepath.Join(directory, "callers.json"),
		"ANTNEST_IDENTITY_CCT_SIGNING_KID":              "startup",
		"ANTNEST_IDENTITY_CCT_SIGNING_KEY_FILE":         filepath.Join(directory, "signing.pem"),
		"ANTNEST_IDENTITY_CCT_JWKS_FILE":                filepath.Join(directory, "jwks.json"),
	}
	return func(key string) (string, bool) { value, present := environment[key]; return value, present }, token
}

func browserStartupAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func TestBrowserStartupRunAppliesConfiguredIdleWithBootstrapDisabled(t *testing.T) {
	for _, withOldSession := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing-session-%t", withOldSession), func(t *testing.T) {
			f := newBrowserStartupFixture(t)
			var activity time.Time
			if withOldSession {
				activity = f.seedOldSession(t)
			}
			address := browserStartupAddress(t)
			lookup, token := browserStartupEnvironment(t, f, address)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			done := make(chan struct{})
			var runErr error
			go func() { defer close(done); runErr = run(ctx, lookup) }()
			t.Cleanup(func() {
				cancel()
				<-done
				if runErr != nil {
					t.Errorf("stop Identity: %v", runErr)
				}
			})
			transport := &http.Transport{}
			t.Cleanup(transport.CloseIdleConnections)
			client := &http.Client{Transport: transport, Timeout: time.Second}
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			for {
				request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+"/status", nil)
				if err != nil {
					t.Fatal(err)
				}
				response, err := client.Do(request)
				if err == nil {
					if closeErr := response.Body.Close(); closeErr != nil {
						t.Fatal(closeErr)
					}
					if response.StatusCode == http.StatusOK {
						break
					}
				}
				select {
				case <-done:
					t.Fatalf("Identity stopped before readiness: %v", runErr)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			if withOldSession {
				var idle time.Time
				if err := f.pool.QueryRow(ctx, `SELECT idle_expires_at FROM api_tokens WHERE id = 'old-token'`).Scan(&idle); err != nil {
					t.Fatal(err)
				}
				if !idle.Equal(activity.Add(5 * time.Second)) {
					t.Fatal("main did not clamp the existing session before listening")
				}
			}
			body, err := json.Marshal(map[string]string{"request_id": "startup-login", "organization_slug": "startup", "email": "startup@example.test", "password": "browser startup test password"})
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+address+"/rpc/identity/local-login", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set(serviceauth.Header, "Bearer "+token)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := response.Body.Close(); err != nil {
					t.Error(err)
				}
			}()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("real local login status = %d", response.StatusCode)
			}
			var login localauth.LoginResult
			if err := json.NewDecoder(response.Body).Decode(&login); err != nil {
				t.Fatal(err)
			}
			var issued, absolute, idle time.Time
			if err := f.pool.QueryRow(ctx, `SELECT issued_at, expires_at, idle_expires_at FROM api_tokens WHERE id = $1`, login.TokenID).Scan(&issued, &absolute, &idle); err != nil {
				t.Fatal(err)
			}
			if idle.Sub(issued) != 5*time.Second || !login.IdleExpiresAt.Equal(idle) || !login.ExpiresAt.Equal(absolute) || login.ActivityIntervalMS != 1666 {
				t.Fatal("main did not apply its 5s idle policy to the real login service")
			}
		})
	}
}

func TestBrowserStartupRunKeepsListenerClosedWhenClampFails(t *testing.T) {
	f := newBrowserStartupFixture(t)
	activity := f.seedOldSession(t)
	address := browserStartupAddress(t)
	lookup, _ := browserStartupEnvironment(t, f, address)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	blocker, err := f.pool.Begin(ctx)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = blocker.Rollback(cleanupCtx)
		cancel()
	}()
	var blockerPID uint32
	if err := blocker.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	lockKey := time.Now().UnixNano()
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockKey); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION fail_browser_clamp() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(%d);
			RAISE EXCEPTION 'browser startup clamp failure' USING ERRCODE = 'P0001';
		END $$;
		CREATE TRIGGER browser_clamp_failure BEFORE UPDATE OF idle_expires_at ON api_tokens
		FOR EACH ROW EXECUTE FUNCTION fail_browser_clamp()`, lockKey)); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var runErr error
	go func() { defer close(done); runErr = run(ctx, lookup) }()
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = blocker.Rollback(cleanupCtx)
		cancel()
		<-done
	})
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND $2::integer = ANY(pg_blocking_pids(pid)))`, f.applicationName, blockerPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		connection, err := net.DialTimeout("tcp", address, 20*time.Millisecond)
		if err == nil {
			_ = connection.Close()
			t.Fatal("Identity opened its listener before admitting the browser session policy")
		}
		select {
		case <-done:
			t.Fatalf("Identity stopped before the clamp barrier: %v", runErr)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	probe, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("listener was already open while startup clamp was blocked: %v", err)
	}
	t.Cleanup(func() {
		if err := probe.Close(); err != nil {
			t.Error(err)
		}
	})
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		var pgError *pgconn.PgError
		if serviceFailureClass(runErr) != "browser_session_initialization" || !errors.As(runErr, &pgError) || pgError.Code != "P0001" || pgError.Message != "browser startup clamp failure" {
			t.Fatalf("startup did not fail at the browser policy boundary: %v", runErr)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var idle time.Time
	if err := f.pool.QueryRow(ctx, `SELECT idle_expires_at FROM api_tokens WHERE id = 'old-token'`).Scan(&idle); err != nil {
		t.Fatal(err)
	}
	if !idle.Equal(activity.Add(30 * time.Minute)) {
		t.Fatal("failed startup committed a partial session clamp")
	}
}
