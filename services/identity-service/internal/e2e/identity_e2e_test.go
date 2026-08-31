package e2e

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
	"soft/antnest-platform/services/identity-service/internal/oidcclient"
	"soft/antnest-platform/services/identity-service/internal/oidcflow"
	"soft/antnest-platform/services/identity-service/internal/repository"
	"soft/antnest-platform/services/identity-service/internal/rpc"
	"soft/antnest-platform/services/identity-service/internal/scim"
	"soft/antnest-platform/services/identity-service/internal/server"
)

func TestIdentityProtocolHappyPath(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	pool := newIsolatedPool(t, databaseURL)
	if err := repository.ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	var sequence atomic.Uint64
	newID := func() string { return fmt.Sprintf("e2e-%d", sequence.Add(1)) }
	store, err := repository.New(pool, newID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	passwordHash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := store.Bootstrap(t.Context(), repository.BootstrapInput{
		OrganizationSlug: "engineering", OrganizationName: "Engineering",
		AdminEmail: "admin@example.com", AdminDisplayName: "Administrator",
		PasswordHash: passwordHash, Now: now,
	})
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	idp := newOIDCProvider(t)
	defer idp.Close()
	identity := httptest.NewUnstartedServer(nil)
	identityURL := "http://" + identity.Listener.Addr().String()
	t.Cleanup(identity.Close)
	federation, err := oidcclient.New(idp.Client())
	if err != nil {
		t.Fatal(err)
	}
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	directoryService := directory.NewService(store.Directory(), newID, time.Now)
	localAuthService, err := localauth.NewService(store.LocalAuth(), newID, time.Now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	oidcService, err := oidcflow.NewService(oidcflow.Config{
		Repository: store.OIDC(), Federation: federation, SecretBox: box,
		NewID: newID, NewOpaque: credentials.NewOpaqueToken, Now: time.Now,
		RedirectURI: identityURL + "/protocol/oidc/callback",
		SessionTTL:  10 * time.Minute, TokenTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	scimService, err := scim.NewService(scim.Config{
		Repository: store.SCIM(), NewID: newID, NewOpaque: credentials.NewOpaqueToken, Now: time.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	rpcHandler, err := rpc.NewHandler(rpc.Dependencies{
		Directory: directoryService, LocalAuth: localAuthService, OIDC: oidcService, SCIM: scimService,
	})
	if err != nil {
		t.Fatal(err)
	}
	scimHandler, err := scim.NewHTTPHandler(scimService, identityURL)
	if err != nil {
		t.Fatal(err)
	}
	handler, readiness, err := server.NewHandler(store, rpcHandler, scimHandler)
	if err != nil {
		t.Fatal(err)
	}
	readiness.Set(true)
	identity.Config.Handler = handler
	identity.Start()

	var login localauth.LoginResult
	postJSON(t, identity.Client(), identity.URL+rpc.ContractRoutes["local_login"], map[string]any{
		"request_id": "login-1", "organization_slug": "engineering",
		"email": "admin@example.com", "password": "correct horse battery staple",
	}, &login)
	if login.Principal.UserID != bootstrap.User.ID || login.AccessToken == "" {
		t.Fatalf("local login = %#v", login)
	}
	assertResolvedPrincipal(t, identity.Client(), identity.URL, login.AccessToken, bootstrap.User.ID)

	var issued scim.IssueTokenResult
	postJSON(t, identity.Client(), identity.URL+rpc.ContractRoutes["issue_scim_token"], map[string]any{
		"request_id": "scim-token-1", "actor_principal_id": bootstrap.User.ID,
		"organization_id": bootstrap.Organization.ID, "name": "test-idp",
		"scopes": []string{domain.SCIMScopeWrite},
	}, &issued)
	var scimUser map[string]any
	scimRequest(t, identity.Client(), http.MethodPost, identity.URL+"/scim/v2/Users", issued.Credential, map[string]any{
		"schemas":    []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		"externalId": "idp-user-1", "userName": "alice@example.com",
		"displayName": "Alice", "active": true,
	}, http.StatusCreated, &scimUser)
	membershipID, _ := scimUser["id"].(string)
	if membershipID == "" {
		t.Fatalf("SCIM user = %#v", scimUser)
	}
	createdUser, err := scimService.GetUser(t.Context(), scim.Authorization{OrganizationID: bootstrap.Organization.ID}, membershipID)
	if err != nil {
		t.Fatalf("load SCIM user: %v", err)
	}

	postJSON(t, identity.Client(), identity.URL+rpc.ContractRoutes["upsert_oidc_provider"], map[string]any{
		"request_id": "provider-1", "actor_principal_id": bootstrap.User.ID,
		"organization_id": bootstrap.Organization.ID, "name": "workforce",
		"issuer": idp.URL, "client_id": "client-1", "client_secret": "client-secret",
		"scopes": []string{"openid", "email", "profile"}, "enabled": true,
	}, &map[string]any{})
	var started oidcflow.StartLoginResult
	postJSON(t, identity.Client(), identity.URL+rpc.ContractRoutes["start_oidc_login"], map[string]any{
		"request_id": "oidc-login-1", "organization_slug": "engineering", "provider_name": "workforce",
	}, &started)
	var completed oidcflow.CompleteLoginResult
	getJSON(t, idp.Client(), started.AuthorizationURL, &completed)
	if completed.Principal.UserID != createdUser.User.ID || completed.AccessToken == "" {
		t.Fatalf("OIDC did not bind the SCIM-created user: %#v", completed)
	}
	assertResolvedPrincipal(t, identity.Client(), identity.URL, completed.AccessToken, createdUser.User.ID)

	var replay oidcflow.CompleteLoginResult
	getJSON(t, idp.Client(), started.AuthorizationURL, &replay)
	if replay.AccessToken != "" || replay.TokenID != completed.TokenID || !replay.AlreadyCompleted || idp.ExchangeCount() != 1 {
		t.Fatalf("OIDC callback was not idempotent: first=%#v replay=%#v exchanges=%d", completed, replay, idp.ExchangeCount())
	}
}

func newIsolatedPool(t *testing.T, databaseURL string) *pgxpool.Pool {
	t.Helper()
	ctx := t.Context()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect PostgreSQL: %v", err)
	}
	schemaName := fmt.Sprintf("identity_e2e_%d", time.Now().UnixNano())
	quotedSchema := pgx.Identifier{schemaName}.Sanitize()
	if _, err := adminPool.Exec(ctx, `CREATE SCHEMA `+quotedSchema); err != nil {
		adminPool.Close()
		t.Fatalf("create isolated schema: %v", err)
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		adminPool.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		adminPool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = adminPool.Exec(context.Background(), `DROP SCHEMA `+quotedSchema+` CASCADE`)
		adminPool.Close()
	})
	return pool
}

func postJSON(t *testing.T, client *http.Client, endpoint string, body any, target any) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", endpoint, err)
	}
	decodeResponse(t, response, http.StatusOK, target)
}

func getJSON(t *testing.T, client *http.Client, endpoint string, target any) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", endpoint, err)
	}
	decodeResponse(t, response, http.StatusOK, target)
}

func scimRequest(
	t *testing.T,
	client *http.Client,
	method string,
	endpoint string,
	token string,
	body any,
	wantStatus int,
	target any,
) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), method, endpoint, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/scim+json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, endpoint, err)
	}
	decodeResponse(t, response, wantStatus, target)
}

func decodeResponse(t *testing.T, response *http.Response, wantStatus int, target any) {
	t.Helper()
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Errorf("close response body: %v", err)
		}
	}()
	if response.StatusCode != wantStatus {
		var failure any
		_ = json.NewDecoder(response.Body).Decode(&failure)
		t.Fatalf("response status = %d, want %d: %#v", response.StatusCode, wantStatus, failure)
	}
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func assertResolvedPrincipal(t *testing.T, client *http.Client, serviceURL, token, wantUserID string) {
	t.Helper()
	var response struct {
		Principal domain.Principal `json:"principal"`
	}
	postJSON(t, client, serviceURL+rpc.ContractRoutes["resolve_access_token"], map[string]string{
		"access_token": token,
	}, &response)
	if response.Principal.UserID != wantUserID || !response.Principal.Active {
		t.Fatalf("resolved principal = %#v, want user %s", response.Principal, wantUserID)
	}
}

type oidcProvider struct {
	*httptest.Server
	key       *rsa.PrivateKey
	mu        sync.Mutex
	nonce     string
	challenge string
	exchanges int
}

func newOIDCProvider(t *testing.T) *oidcProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	provider := &oidcProvider{key: key}
	provider.Server = httptest.NewTLSServer(http.HandlerFunc(provider.handle))
	return provider
}

func (p *oidcProvider) ExchangeCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exchanges
}

func (p *oidcProvider) handle(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-Type", "application/json")
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		writeJSON(response, map[string]any{
			"issuer": p.URL, "authorization_endpoint": p.URL + "/authorize",
			"token_endpoint": p.URL + "/token", "userinfo_endpoint": p.URL + "/userinfo",
			"jwks_uri":                              p.URL + "/jwks",
			"token_endpoint_auth_methods_supported": []string{"client_secret_basic"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/authorize":
		p.mu.Lock()
		p.nonce = request.URL.Query().Get("nonce")
		p.challenge = request.URL.Query().Get("code_challenge")
		p.mu.Unlock()
		callback, err := url.Parse(request.URL.Query().Get("redirect_uri"))
		if err != nil {
			http.Error(response, "invalid redirect", http.StatusBadRequest)
			return
		}
		query := callback.Query()
		query.Set("state", request.URL.Query().Get("state"))
		query.Set("code", "authorization-code")
		callback.RawQuery = query.Encode()
		http.Redirect(response, request, callback.String(), http.StatusFound)
	case "/token":
		if err := request.ParseForm(); err != nil {
			http.Error(response, "invalid form", http.StatusBadRequest)
			return
		}
		p.mu.Lock()
		verifier := request.Form.Get("code_verifier")
		validChallenge := p.challenge == pkceChallenge(verifier)
		nonce := p.nonce
		p.exchanges++
		p.mu.Unlock()
		if request.Form.Get("code") != "authorization-code" || !validChallenge {
			http.Error(response, "invalid exchange", http.StatusBadRequest)
			return
		}
		writeJSON(response, map[string]any{
			"access_token": "provider-access-token", "token_type": "Bearer",
			"id_token": p.signIDToken(nonce),
		})
	case "/jwks":
		writeJSON(response, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "test-key",
			"n": base64.RawURLEncoding.EncodeToString(p.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(p.key.E)).Bytes()),
		}}})
	case "/userinfo":
		if request.Header.Get("Authorization") != "Bearer provider-access-token" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		writeJSON(response, map[string]any{
			"sub": "subject-1", "email": "alice@example.com", "email_verified": true, "name": "Alice",
		})
	default:
		http.NotFound(response, request)
	}
}

func (p *oidcProvider) signIDToken(nonce string) string {
	now := time.Now().UTC()
	header := encodeSegment(map[string]any{"alg": "RS256", "typ": "JWT", "kid": "test-key"})
	claims := encodeSegment(map[string]any{
		"iss": p.URL, "sub": "subject-1", "aud": "client-1", "nonce": nonce,
		"iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
		"email": "alice@example.com", "email_verified": true, "name": "Alice",
	})
	unsigned := header + "." + claims
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func pkceChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func encodeSegment(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func writeJSON(response http.ResponseWriter, value any) {
	if err := json.NewEncoder(response).Encode(value); err != nil && !strings.Contains(err.Error(), "closed") {
		panic(err)
	}
}
