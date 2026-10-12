package e2e

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/identityid"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcclient"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/rpc"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

const (
	resourcePassword = "password resource integration fixture"
	// The host diagnostic relay permits 64 connections in total. Leave room
	// for schema administration while exceeding two active + 32 queued KDFs.
	resourceDatabaseConnections = 48
)

// This component fixture uses the real authority, RPC adapters, PostgreSQL
// repositories and KDF. Bootstrap, dummy preparation and all three password
// applications share exactly one engine, as in the production composition root.
type passwordResourceFixture struct {
	pool      *pgxpool.Pool
	engine    *credentials.Engine
	config    credentials.PasswordConfig
	admin     repository.BootstrapResult
	handler   http.Handler
	workloads map[string]string
}

func newPasswordResourceFixture(t *testing.T) passwordResourceFixture {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal("parse isolated test database URL")
	}
	query := parsed.Query()
	query.Set("pool_max_conns", fmt.Sprint(resourceDatabaseConnections))
	parsed.RawQuery = query.Encode()
	pool := newIsolatedPool(t, parsed.String())
	if err := repository.ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	store, err := repository.New(pool, identityid.MustNew, storedNow)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.InitializeBrowserSessions(t.Context(), time.Hour); err != nil {
		t.Fatal(err)
	}
	config := credentials.DefaultPasswordConfig()
	config.MaxConcurrent = 2
	engine, err := credentials.NewEngine(config)
	if err != nil {
		t.Fatal(err)
	}
	// Cleanup registration is LIFO: join kernels before closing PostgreSQL.
	t.Cleanup(engine.Close)
	hash, err := engine.HashPassword(t.Context(), resourcePassword)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := store.Bootstrap(t.Context(), repository.BootstrapInput{
		OrganizationSlug: "password-resources", OrganizationName: "Password resources",
		AdminEmail: "admin@example.test", AdminDisplayName: "Administrator",
		PasswordHash: hash, Now: storedNow(),
	})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := localauth.NewService(t.Context(), store.LocalAuth(), identityid.MustNew, storedNow, time.Hour, engine)
	if err != nil {
		t.Fatal(err)
	}
	federation, err := oidcclient.New(http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	oidc, err := oidcflow.NewService(oidcflow.Config{
		Repository: store.OIDC(), Federation: federation, SecretBox: box,
		NewID: identityid.MustNew, NewOpaque: credentials.NewOpaqueToken, Now: storedNow,
		RedirectURI: "http://127.0.0.1/protocol/oidc/callback", SessionTTL: 10 * time.Minute, TokenTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	scimService, err := scim.NewService(scim.Config{
		Repository: store.SCIM(), NewID: identityid.MustNew, NewOpaque: credentials.NewOpaqueToken, Now: storedNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	authentication, authority, tokens := identityTestAuthentication(t, store)
	handler, err := rpc.NewHandler(rpc.Dependencies{
		Directory: directory.NewService(store.Directory(), identityid.MustNew, storedNow, engine),
		LocalAuth: auth, OIDC: oidc, SCIM: scimService,
		BrowserSessions:    browsersessions.NewService(store.BrowserSessions(), engine),
		ExternalIdentities: externalidentities.NewService(store.ExternalIdentities()),
		Authentication:     authentication, CallerContext: authority,
	})
	if err != nil {
		t.Fatal(err)
	}
	return passwordResourceFixture{pool: pool, engine: engine, config: config, admin: admin, handler: handler, workloads: tokens}
}

func resourceLoginBody(slug, email string) map[string]any {
	return map[string]any{"request_id": "resource-login", "organization_slug": slug, "email": email, "password": resourcePassword}
}

func (f passwordResourceFixture) request(ctx context.Context, method string, body any, workload, cct string) (*httptest.ResponseRecorder, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, rpc.ContractRoutes[method], bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.Header, "Bearer "+f.workloads[workload])
	if cct != "" {
		request.Header.Set(callercontext.Header, cct)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response, nil
}

func (f passwordResourceFixture) call(t *testing.T, method string, body any, workload, cct string, status int, result any) *httptest.ResponseRecorder {
	t.Helper()
	response, err := f.request(t.Context(), method, body, workload, cct)
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != status {
		t.Fatalf("%s status=%d want=%d", method, response.Code, status)
	}
	if result != nil {
		if err := json.Unmarshal(response.Body.Bytes(), result); err != nil {
			t.Fatal(err)
		}
	}
	return response
}

func assertResourceBusy(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"code": "credential_busy", "message": "Password verification is busy", "retryable": true}
	if response.Code != 503 || !reflect.DeepEqual(body, want) || response.Header().Get("Retry-After") != "1" || response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatal("password admission response lost its closed public contract")
	}
}

func (f passwordResourceFixture) assertIssued(t *testing.T, want int) {
	t.Helper()
	var tokens, events int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM api_tokens),
		(SELECT count(*) FROM identity_events WHERE event_type = 'access_token.issued')`).Scan(&tokens, &events); err != nil {
		t.Fatal(err)
	}
	if tokens != want || events != want {
		t.Fatalf("tokens=%d issuance events=%d want=%d each", tokens, events, want)
	}
}

func TestPasswordResourcePostgresPressureDrainsAndRecovers(t *testing.T) {
	f := newPasswordResourceFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	// Open and hold every slot before the burst. The real database, not merely
	// its configured maximum, must support more than two active + 32 queued KDFs.
	connections := make([]*pgxpool.Conn, 0, resourceDatabaseConnections)
	defer func() {
		for _, connection := range connections {
			connection.Release()
		}
	}()
	for range resourceDatabaseConnections {
		connection, err := f.pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("database pressure connections: acquired=%d want=%d", len(connections), resourceDatabaseConnections)
		}
		connections = append(connections, connection)
	}
	if f.pool.Stat().AcquiredConns() != resourceDatabaseConnections || int(f.pool.Config().MaxConns) <= f.config.MaxConcurrent+32 {
		t.Fatal("database pool would conceal KDF admission pressure")
	}
	for _, connection := range connections {
		connection.Release()
	}
	connections = nil
	const requests = 200
	start := make(chan struct{})
	type outcome struct {
		response *httptest.ResponseRecorder
		err      error
	}
	results := make(chan outcome, requests)
	var workers sync.WaitGroup
	for index := range requests {
		workers.Go(func() {
			<-start
			// Distinct unknown namespaces cannot serialize on one account or
			// Organization bucket when persisted attempts are introduced.
			body := resourceLoginBody(fmt.Sprintf("unknown-resource-%d", index), fmt.Sprintf("unknown-%d@example.test", index))
			body["request_id"] = fmt.Sprintf("resource-pressure-%d", index)
			response, err := f.request(ctx, "local_login", body, "edge-gateway", "")
			results <- outcome{response: response, err: err}
		})
	}
	close(start)
	workers.Wait()
	close(results)
	busy, denied := 0, 0
	for result := range results {
		if result.err != nil {
			t.Fatal("pressure request failed before receiving an RPC response")
		}
		switch result.response.Code {
		case http.StatusServiceUnavailable:
			assertResourceBusy(t, result.response)
			busy++
		case http.StatusUnauthorized:
			var failure struct{ Code string }
			if err := json.Unmarshal(result.response.Body.Bytes(), &failure); err != nil || failure.Code != "unauthenticated" || len(result.response.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("dummy verification did not return canonical unauthenticated")
			}
			denied++
		default:
			t.Fatalf("pressure status=%d; want an actual KDF 503 or completed dummy 401", result.response.Code)
		}
	}
	stats := f.engine.Stats()
	if busy == 0 || denied == 0 || busy+denied != requests || uint64(busy) != stats.QueueRejected+stats.WaitExpired || stats.OverBudget != 0 {
		t.Fatalf("pressure lacks KDF attribution: busy=%d denied=%d stats=%+v", busy, denied, stats)
	}
	if stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 || stats.PeakActive != f.config.MaxConcurrent || stats.PeakMemoryKiB > f.config.MemoryBudgetKiB {
		t.Fatalf("resource budget or drain failed: %+v", stats)
	}
	f.assertIssued(t, 0)
	var recovered localauth.LoginResult
	f.call(t, "local_login", resourceLoginBody("password-resources", "admin@example.test"), "edge-gateway", "", 200, &recovered)
	if recovered.AccessToken == "" || recovered.Principal.UserID != f.admin.User.ID {
		t.Fatal("real login did not recover after pressure drained")
	}
	f.assertIssued(t, 1)
	t.Logf("pressure: requests=%d busy=%d denied=%d warmed_database_connections=%d stats=%+v recovery=passed", requests, busy, denied, resourceDatabaseConnections, stats)
}

func TestPasswordResourcePostgresStoredPolicies(t *testing.T) {
	f := newPasswordResourceFixture(t)
	// Produce an independent historical PHC fixture; m=17 must stay 17 even
	// though Argon2 internally rounds its memory allocation to lane blocks.
	salt := []byte("sixteen-bytesalt")
	key := argon2.IDKey([]byte(resourcePassword), salt, 1, 17, 1, 32)
	legacy := fmt.Sprintf("$argon2id$v=19$m=17,t=1,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
	if needs, err := f.engine.NeedsRehash(legacy); err != nil || !needs {
		t.Fatal("historical hash is not a valid rehash candidate")
	}
	setHash := func(t *testing.T, hash string) {
		t.Helper()
		if _, err := f.pool.Exec(t.Context(), "UPDATE local_credentials SET password_hash=$2 WHERE user_id=$1", f.admin.User.ID, hash); err != nil {
			t.Fatal(err)
		}
	}
	setHash(t, legacy)
	var login localauth.LoginResult
	f.call(t, "local_login", resourceLoginBody("password-resources", "admin@example.test"), "edge-gateway", "", 200, &login)
	if login.AccessToken == "" {
		t.Fatal("historical parameters did not authenticate through PostgreSQL")
	}
	f.assertIssued(t, 1)
	for _, test := range []struct {
		name, parameters string
		status           int
	}{
		{"over_budget", "m=196608,t=1,p=1", 503},
		{"malformed", "m=1048577,t=1,p=1", 500},
	} {
		t.Run(test.name, func(t *testing.T) {
			setHash(t, fmt.Sprintf("$argon2id$v=19$%s$%s$%s", test.parameters, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)))
			response := f.call(t, "local_login", resourceLoginBody("password-resources", "admin@example.test"), "edge-gateway", "", test.status, nil)
			if test.status == 503 {
				assertResourceBusy(t, response)
			} else if bytes.Contains(response.Body.Bytes(), []byte(test.parameters)) || response.Header().Get("Retry-After") != "" {
				t.Fatal("invalid stored hash leaked or was mislabeled as admission pressure")
			}
			f.assertIssued(t, 1)
		})
	}
	if stats := f.engine.Stats(); stats.OverBudget != 1 || stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 {
		t.Fatalf("stored policy admission did not drain: %+v", stats)
	}
}

func TestPasswordResourcePostgresStoppedEnginePreservesCredentials(t *testing.T) {
	f := newPasswordResourceFixture(t)
	var login localauth.LoginResult
	f.call(t, "local_login", resourceLoginBody("password-resources", "admin@example.test"), "edge-gateway", "", 200, &login)
	contextFor := func(profile string) string {
		t.Helper()
		var result struct {
			CallerContext string `json:"caller_context"`
		}
		f.call(t, "resolve_access_token", map[string]any{"access_token": login.AccessToken, "profile": profile}, "edge-gateway", "", 200, &result)
		if result.CallerContext == "" {
			t.Fatal("live session did not receive caller authority")
		}
		return result.CallerContext
	}
	console, session := contextFor("console"), contextFor("session")
	createBody := func(name string) map[string]any {
		return map[string]any{"request_id": "create-" + name, "actor_principal_id": f.admin.User.ID, "organization_id": f.admin.Organization.ID,
			"email": name + "@example.test", "display_name": name, "password": resourcePassword, "role": "member"}
	}
	for _, name := range []string{"inactive", "missing-password"} {
		var user directory.CreateLocalUserResult
		f.call(t, "create_local_user", createBody(name), "admin-console", console, 200, &user)
		statement := "UPDATE users SET active=FALSE WHERE id=$1"
		if name == "missing-password" {
			statement = "DELETE FROM local_credentials WHERE user_id=$1"
		}
		if _, err := f.pool.Exec(t.Context(), statement, user.User.ID); err != nil {
			t.Fatal(err)
		}
	}
	snapshot := func() map[string][sha256.Size]byte {
		t.Helper()
		result := make(map[string][sha256.Size]byte)
		for _, table := range []string{"users", "local_credentials", "api_tokens", "identity_events", "organization_memberships", "session_revocations", "principal_revocations"} {
			var rows string
			statement := `SELECT COALESCE(jsonb_agg(to_jsonb(snapshot_row) ORDER BY to_jsonb(snapshot_row)::text), '[]'::jsonb)::text FROM ` + pgx.Identifier{table}.Sanitize() + ` AS snapshot_row`
			if err := f.pool.QueryRow(t.Context(), statement).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			// Compare whole rows so unchanged counts cannot conceal token
			// renewal, credential mutation or a new revocation. Never log rows.
			result[table] = sha256.Sum256([]byte(rows))
		}
		return result
	}
	before := snapshot()
	f.engine.Stop()
	for _, test := range []struct{ name, slug, email string }{
		{"known", "password-resources", "admin@example.test"},
		{"unknown", "unknown-resources", "unknown@example.test"},
		{"invalid", "!invalid", "invalid"},
		{"inactive", "password-resources", "inactive@example.test"},
		{"missing", "password-resources", "missing-password@example.test"},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertResourceBusy(t, f.call(t, "local_login", resourceLoginBody(test.slug, test.email), "edge-gateway", "", 503, nil))
		})
	}
	assertResourceBusy(t, f.call(t, "create_local_user", createBody("rejected"), "admin-console", console, 503, nil))
	passwordBody := map[string]any{"request_id": "stopped-change", "actor_principal_id": f.admin.User.ID, "user_id": f.admin.User.ID,
		"current_password": resourcePassword, "new_password": "replacement password fixture"}
	assertResourceBusy(t, f.call(t, "change_local_password", passwordBody, "edge-gateway", session, 503, nil))
	if !reflect.DeepEqual(snapshot(), before) {
		t.Fatal("rejected password work changed credentials, membership, tokens, audit or revocations")
	}
	contextFor("session") // Existing credentials remain usable after admission rejects new work.
	f.engine.Close()
	if stats := f.engine.Stats(); stats.Active != 0 || stats.MemoryKiB != 0 || stats.Queued != 0 {
		t.Fatalf("stopped engine retained permits after join: %+v", stats)
	}
}
