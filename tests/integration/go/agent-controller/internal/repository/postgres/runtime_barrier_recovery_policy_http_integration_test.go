package postgres

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/server"
)

const runtimeBarrierPolicyHTTPPath = "/internal/runtime-barrier-recovery-policy"

func TestRuntimeBarrierRecoveryPolicyHTTPDefaultPreservesConfiguredHistoryWithoutRecovery(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	base, _ := seedAvailableAgentForRebuild(t, ctx, store)
	history := runtimeBarrierPolicyHTTPHistorySnapshot(t, ctx, store)
	auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
	endpoint := newRuntimeBarrierPolicyHTTPServer(t, store, auth.security)
	cct := auth.sign(t, map[string]any{"org": base.Agent.OrganizationID})
	path := runtimeBarrierPolicyHTTPPath + "?organization_id=" + url.QueryEscape(base.Agent.OrganizationID)
	for range 2 {
		response := endpoint.request(t, ctx, http.MethodGet, path, nil, auth.tokens["admin-console"], cct)
		policy := decodeRuntimeBarrierPolicyHTTPSuccess(t, response)
		require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
			OrganizationID: base.Agent.OrganizationID, Revision: 0, Mode: "manual", CooldownMS: 300000,
		}, policy)
		assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
		require.Equal(t, history, runtimeBarrierPolicyHTTPHistorySnapshot(t, ctx, store),
			"reading an old organization's default must not admit recovery or change its configured history")
	}
}

func TestRuntimeBarrierRecoveryPolicyHTTPReopenReplaysOriginalReceiptWithCurrentAuthorization(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
	firstHTTP := newRuntimeBarrierPolicyHTTPServer(t, store, auth.security)
	originalCCT := auth.sign(t, nil)
	firstBody := runtimeBarrierPolicyHTTPBody(t, "http-first", 0, "auto", 60000)
	first := decodeRuntimeBarrierPolicyHTTPSuccess(t,
		firstHTTP.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, firstBody, auth.tokens["admin-console"], originalCCT))
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: "policy-http-org", Revision: 1, Mode: "auto", CooldownMS: 60000,
	}, first)
	secondBody := runtimeBarrierPolicyHTTPBody(t, "http-second", 1, "notify", 86400000)
	second := decodeRuntimeBarrierPolicyHTTPSuccess(t,
		firstHTTP.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, secondBody, auth.tokens["admin-console"], originalCCT))
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: "policy-http-org", Revision: 2, Mode: "notify", CooldownMS: 86400000,
	}, second)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 2)

	// Close the first owners before reopening: no in-memory request cache can
	// provide the original result to the second service/server instance.
	firstHTTP.close()
	store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	restartedHTTP := newRuntimeBarrierPolicyHTTPServer(t, reopened, auth.security)
	replayed := decodeRuntimeBarrierPolicyHTTPSuccess(t,
		restartedHTTP.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, firstBody, auth.tokens["admin-console"], originalCCT))
	require.Equal(t, first, replayed)
	getPath := runtimeBarrierPolicyHTTPPath + "?organization_id=policy-http-org"
	current := decodeRuntimeBarrierPolicyHTTPSuccess(t,
		restartedHTTP.request(t, ctx, http.MethodGet, getPath, nil, auth.tokens["admin-console"], originalCCT))
	require.Equal(t, second, current)
	before := runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, reopened)
	now := time.Now().Unix()
	for _, scenario := range []struct {
		name   string
		token  string
		cct    string
		status int
		code   string
	}{
		{"missing-workload", "", originalCCT, http.StatusUnauthorized, "service_unauthenticated"},
		{"invalid-workload", "invalid-workload-token", originalCCT, http.StatusUnauthorized, "service_unauthenticated"},
		{"foreign-workload", auth.tokens["agent-ui"], originalCCT, http.StatusForbidden, "caller_not_allowed"},
		{"missing-cct", auth.tokens["admin-console"], "", http.StatusUnauthorized, "caller_context_required"},
		{"invalid-cct", auth.tokens["admin-console"], "invalid-cct", http.StatusUnauthorized, "caller_context_invalid"},
		{"expired-cct", auth.tokens["admin-console"], auth.sign(t, map[string]any{"iat": now - 120, "exp": now - 60}), http.StatusUnauthorized, "caller_context_invalid"},
		{"non-administrator", auth.tokens["admin-console"], auth.sign(t, map[string]any{"org_role": "member", "sys_role": "user"}), http.StatusForbidden, "forbidden"},
		{"foreign-organization", auth.tokens["admin-console"], auth.sign(t, map[string]any{"org": "another-org"}), http.StatusForbidden, "organization_mismatch"},
		{"foreign-actor", auth.tokens["admin-console"], auth.sign(t, map[string]any{"sub": "another-admin"}), http.StatusForbidden, "actor_mismatch"},
		{"foreign-audience", auth.tokens["admin-console"], auth.sign(t, map[string]any{"aud": []string{"admin-console"}}), http.StatusUnauthorized, "caller_context_invalid"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// The original bytes, including request ID and stale CAS, are the
			// same for every denial; a durable receipt never grants authority.
			response := restartedHTTP.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, firstBody, scenario.token, scenario.cct)
			assertRuntimeBarrierPolicyHTTPError(t, response, scenario.status, scenario.code)
			require.Equal(t, before, runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, reopened))
		})
	}
	freshCCT := auth.sign(t, map[string]any{"jti": "policy-context-renewed"})
	require.NotEqual(t, sha256.Sum256([]byte(originalCCT)), sha256.Sum256([]byte(freshCCT)))
	replayed = decodeRuntimeBarrierPolicyHTTPSuccess(t,
		restartedHTTP.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, firstBody, auth.tokens["admin-console"], freshCCT))
	require.Equal(t, first, replayed, "fresh valid authorization must still replay the original receipt")
	current = decodeRuntimeBarrierPolicyHTTPSuccess(t,
		restartedHTTP.request(t, ctx, http.MethodGet, getPath, nil, auth.tokens["admin-console"], freshCCT))
	require.Equal(t, second, current)
	require.Equal(t, before, runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, reopened))
	assertRuntimeBarrierPolicyRows(t, ctx, reopened, 1, 2)
}

func TestRuntimeBarrierRecoveryPolicyHTTPDistinguishesCASFromChangedRequestIdentity(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
	endpoint := newRuntimeBarrierPolicyHTTPServer(t, store, auth.security)
	cct := auth.sign(t, nil)
	firstBody := runtimeBarrierPolicyHTTPBody(t, "http-original", 0, "manual", 300000)
	first := decodeRuntimeBarrierPolicyHTTPSuccess(t,
		endpoint.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, firstBody, auth.tokens["admin-console"], cct))
	require.EqualValues(t, 1, first.Revision)
	before := runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, store)
	stale := runtimeBarrierPolicyHTTPBody(t, "http-new-stale", 0, "notify", 300000)
	response := endpoint.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, stale, auth.tokens["admin-console"], cct)
	assertRuntimeBarrierPolicyHTTPError(t, response, http.StatusConflict, "resource_version_conflict")
	require.Equal(t, before, runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, store))
	changed := runtimeBarrierPolicyHTTPBody(t, "http-original", 0, "auto", 300000)
	response = endpoint.request(t, ctx, http.MethodPut, runtimeBarrierPolicyHTTPPath, changed, auth.tokens["admin-console"], cct)
	assertRuntimeBarrierPolicyHTTPError(t, response, http.StatusConflict, "request_id_conflict")
	require.Equal(t, before, runtimeBarrierPolicyHTTPPersistenceSnapshot(t, ctx, store))
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 1)
}

type runtimeBarrierPolicyHTTPAuthentication struct {
	security server.Security
	tokens   map[string]string
	key      ed25519.PrivateKey
}

func newRuntimeBarrierPolicyHTTPAuthentication(t *testing.T) *runtimeBarrierPolicyHTTPAuthentication {
	t.Helper()
	tokens := make(map[string]string)
	hashes := make(map[string][]string)
	for _, caller := range serviceauth.Services {
		if caller == "agent-controller" {
			continue
		}
		raw := make([]byte, 32)
		_, err := rand.Read(raw)
		require.NoError(t, err)
		token := base64.RawURLEncoding.EncodeToString(raw)
		digest := sha256.Sum256([]byte(token))
		tokens[caller] = token
		hashes[caller] = []string{"sha256:" + hex.EncodeToString(digest[:])}
	}
	raw, err := json.Marshal(hashes)
	require.NoError(t, err)
	receiver, err := serviceauth.ParseReceiver("agent-controller", raw, false)
	require.NoError(t, err)
	publicKey, key, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	jwks, err := json.Marshal(map[string]any{"keys": []any{map[string]string{
		"kid": "policy-fixture", "kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA",
		"x": base64.RawURLEncoding.EncodeToString(publicKey),
	}}})
	require.NoError(t, err)
	identity := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/rpc/identity/jwks" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write(jwks)
	}))
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(func() {
		transport.CloseIdleConnections()
		identity.Close()
		transport.CloseIdleConnections()
	})
	verifier, err := callercontext.NewVerifier(identity.URL, &http.Client{
		Transport: transport, Timeout: 5 * time.Second,
	}, 5*time.Second)
	require.NoError(t, err)
	return &runtimeBarrierPolicyHTTPAuthentication{
		security: server.Security{Authentication: receiver, CallerContext: verifier},
		tokens:   tokens, key: key,
	}
}

func (auth *runtimeBarrierPolicyHTTPAuthentication) sign(t *testing.T, overrides map[string]any) string {
	t.Helper()
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": callercontext.Issuer, "sub": "policy-admin", "org": "policy-http-org", "mbr": "policy-membership",
		"sys_role": "user", "org_role": "admin", "sid": "policy-session", "aud": []string{"agent-controller"},
		"iat": now, "exp": now + 60, "jti": "policy-context-original",
	}
	for key, value := range overrides {
		claims[key] = value
	}
	header, err := json.Marshal(map[string]string{"typ": "antnest-cct+jwt", "alg": "EdDSA", "kid": "policy-fixture"})
	require.NoError(t, err)
	body, err := json.Marshal(claims)
	require.NoError(t, err)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(auth.key, []byte(input)))
}

type runtimeBarrierPolicyHTTPServer struct {
	server    *httptest.Server
	transport *http.Transport
	client    *http.Client
	once      sync.Once
}

func newRuntimeBarrierPolicyHTTPServer(t *testing.T, store *Repository, security server.Security) *runtimeBarrierPolicyHTTPServer {
	t.Helper()
	boundary, err := server.WithRuntimeBarrierRecoveryPolicyRoutes(http.NotFoundHandler(),
		application.NewRuntimeBarrierRecoveryPolicyService(store), security)
	require.NoError(t, err)
	endpoint := &runtimeBarrierPolicyHTTPServer{
		server: httptest.NewServer(boundary), transport: &http.Transport{Proxy: nil},
	}
	endpoint.client = &http.Client{
		Transport: endpoint.transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	t.Cleanup(endpoint.close)
	return endpoint
}

func (endpoint *runtimeBarrierPolicyHTTPServer) close() {
	endpoint.once.Do(func() {
		endpoint.transport.CloseIdleConnections()
		endpoint.server.Close()
		endpoint.transport.CloseIdleConnections()
	})
}

type runtimeBarrierPolicyHTTPResponse struct {
	status int
	header http.Header
	body   []byte
}

func (endpoint *runtimeBarrierPolicyHTTPServer) request(t *testing.T, ctx context.Context, method, path string, body []byte, token, cct string) runtimeBarrierPolicyHTTPResponse {
	t.Helper()
	requestContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, method, endpoint.server.URL+path, bytes.NewReader(body))
	require.NoError(t, err)
	if token != "" {
		request.Header.Set(serviceauth.Header, "Bearer "+token)
	}
	if cct != "" {
		request.Header.Set(callercontext.Header, cct)
	}
	if method == http.MethodPut {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := endpoint.client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	raw, readError := io.ReadAll(response.Body)
	closeError := response.Body.Close()
	require.NoError(t, readError)
	require.NoError(t, closeError)
	return runtimeBarrierPolicyHTTPResponse{status: response.StatusCode, header: response.Header.Clone(), body: raw}
}

func runtimeBarrierPolicyHTTPBody(t *testing.T, requestID string, revision int64, mode string, cooldown int64) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"request_id": requestID, "organization_id": "policy-http-org", "actor_principal_id": "policy-admin",
		"expected_revision": revision, "mode": mode, "cooldown_ms": cooldown,
	})
	require.NoError(t, err)
	return body
}

func decodeRuntimeBarrierPolicyHTTPSuccess(t *testing.T, response runtimeBarrierPolicyHTTPResponse) domain.RuntimeBarrierRecoveryPolicy {
	t.Helper()
	require.Equal(t, http.StatusOK, response.status)
	require.Equal(t, "no-store", response.header.Get("Cache-Control"))
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(response.body, &fields))
	require.Len(t, fields, 4)
	for _, field := range []string{"organization_id", "revision", "mode", "cooldown_ms"} {
		require.Contains(t, fields, field)
	}
	var policy domain.RuntimeBarrierRecoveryPolicy
	decoder := json.NewDecoder(bytes.NewReader(response.body))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&policy))
	var trailing any
	require.ErrorIs(t, decoder.Decode(&trailing), io.EOF)
	return policy
}

func assertRuntimeBarrierPolicyHTTPError(t *testing.T, response runtimeBarrierPolicyHTTPResponse, status int, code string) {
	t.Helper()
	require.Equal(t, status, response.status)
	var failure struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}
	decoder := json.NewDecoder(bytes.NewReader(response.body))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&failure))
	var trailing any
	require.ErrorIs(t, decoder.Decode(&trailing), io.EOF)
	require.Equal(t, code, failure.Code)
	require.NotEmpty(t, failure.Message)
	require.False(t, failure.Retryable)
}

func runtimeBarrierPolicyHTTPPersistenceSnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	err := store.pool.QueryRow(ctx, `SELECT jsonb_build_object(
'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id)
    FROM agent_controller.runtime_barrier_recovery_policies p),
'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY organization_id,request_id)
    FROM agent_controller.runtime_barrier_recovery_policy_requests r))::text`).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}

func runtimeBarrierPolicyHTTPHistorySnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	err := store.pool.QueryRow(ctx, `SELECT jsonb_build_object(
'agents',(SELECT jsonb_object_agg(id,to_jsonb(a)) FROM agent_controller.agents a),
'specs',(SELECT jsonb_object_agg(id,to_jsonb(s)) FROM agent_controller.agent_spec_revisions s),
'executions',(SELECT jsonb_object_agg(id,to_jsonb(e)) FROM agent_controller.execution_revisions e),
'operations',(SELECT jsonb_object_agg(request_id,to_jsonb(o)) FROM agent_controller.agent_lifecycle_operations o),
'events',(SELECT jsonb_object_agg(global_sequence::text,to_jsonb(v)) FROM agent_controller.agent_events v))::text`).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}
